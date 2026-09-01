import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { Contract, defineTelemetryContract } from "../src/index.ts";

const compile = (version: number) =>
  defineTelemetryContract({
    version,
    events: {
      PaymentAttempt: {
        name: "payment.attempt",
        kind: "operation",
        defaultSeverity: "info",
        mandatory: true,
        sampling: { kind: "always" },
        attributes: {
          "payment.provider": {
            classification: "public",
            required: true,
            metricLabel: true,
          },
        },
      },
    },
    metrics: {
      PaymentLatency: {
        name: "payment.latency",
        description: "Payment latency",
        unit: "ms",
        kind: "histogram",
        boundaries: [10, 100],
        attributes: {
          "payment.provider": {
            classification: "public",
            maximumCardinality: 2,
            allowedValues: ["stripe", "adyen"],
          },
        },
      },
    },
    auditActions: {},
  });

const surface = async (
  version: number,
  eventName = "payment.attempt",
  aliases: Contract.ContractSignalAliasMetadata = { version: 1, aliases: [] },
): Promise<Contract.ContractSurface> => {
  const projected = Contract.contractSurface({
    contract: await Effect.runPromise(compile(version)),
    service: "checkout",
    aliases,
    browserEnvelopeVersion: 1,
    retentionWindowDays: 30,
  });
  return eventName === "payment.attempt"
    ? projected
    : {
        ...projected,
        events: projected.events.map((event) => ({ ...event, name: eventName })),
      };
};

describe("contract compatibility", () => {
  it("encodes and decodes a deterministic strict surface", async () => {
    const candidate = await surface(2);
    const encoded = Contract.encodeContractSurface(candidate);
    const decoded = await Effect.runPromise(Contract.decodeContractSurface(encoded));
    expect(decoded).toEqual(candidate);
    expect(Contract.encodeContractSurface(decoded)).toBe(encoded);
  });

  it("accepts additions without a contract version bump", async () => {
    const baseline = await surface(1);
    const optionalAttribute: Contract.ContractSurfaceEventAttribute = {
      name: "payment.method",
      classification: "public",
      required: false,
      metricLabel: false,
    };
    const addedEvent: Contract.ContractSurfaceEvent = {
      name: "payment.refund",
      kind: "domain",
      outcomeMeaning: ["cancelled", "failure", "success"],
      attributes: [],
    };
    const candidate: Contract.ContractSurface = {
      ...baseline,
      events: [
        ...baseline.events.map((event) => ({
          ...event,
          attributes: [...event.attributes, optionalAttribute],
        })),
        addedEvent,
      ],
    };
    const report = Contract.classifyContractChange({ baseline, candidate, now: "2026-09-01" });
    expect(report.accepted).toBe(true);
    expect(report.findings.map((entry) => entry.code)).toEqual([
      "OBS_COMPAT_ATTRIBUTE_ADDED",
      "OBS_COMPAT_EVENT_ADDED",
    ]);
  });

  it("requires a higher contract version and a retained alias for a rename", async () => {
    const baseline = await surface(1);
    const withoutVersion = await surface(1, "payment.started", {
      version: 1,
      aliases: [
        {
          source: { kind: "event", name: "payment.attempt" },
          target: { kind: "event", name: "payment.started" },
          since: "2026-08-31",
        },
      ],
    });
    const rejected = Contract.classifyContractChange({
      baseline,
      candidate: withoutVersion,
      now: "2026-09-01",
    });
    expect(rejected.accepted).toBe(false);
    expect(
      rejected.findings.find((entry) => entry.code === "OBS_COMPAT_EVENT_RENAMED"),
    ).toMatchObject({
      aliasStatus: "active",
      requiredContractVersion: 2,
      satisfied: false,
    });
    const accepted = Contract.classifyContractChange({
      baseline,
      candidate: { ...withoutVersion, contractVersion: 2 },
      now: "2026-09-01",
    });
    expect(
      accepted.findings.find((entry) => entry.code === "OBS_COMPAT_EVENT_RENAMED")?.satisfied,
    ).toBe(true);
  });

  it("rejects semantic changes in place even with a version bump", async () => {
    const baseline = await surface(1);
    const changedMetric = {
      ...baseline,
      contractVersion: 2,
      metrics: baseline.metrics.map((metric) => ({ ...metric, unit: "s" })),
    } satisfies Contract.ContractSurface;
    const report = Contract.classifyContractChange({
      baseline,
      candidate: changedMetric,
      now: "2026-09-01",
    });
    expect(report.accepted).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "OBS_COMPAT_METRIC_UNIT_CHANGED", satisfied: false }),
    );
  });

  it("reports retention boundaries and rejects window resets", async () => {
    const baseline = await surface(1, "payment.attempt", {
      version: 1,
      aliases: [
        {
          source: { kind: "event", name: "payment.charge" },
          target: { kind: "event", name: "payment.attempt" },
          since: "2026-08-31",
        },
      ],
    });
    const boundary = Contract.classifyContractChange({
      baseline,
      candidate: baseline,
      now: "2026-09-30",
    });
    expect(boundary.findings).toContainEqual(
      expect.objectContaining({ code: "OBS_COMPAT_ALIAS_WINDOW_EXPIRED", aliasStatus: "expired" }),
    );
    const reset = {
      ...baseline,
      contractVersion: 2,
      aliases: baseline.aliases.map((alias) => ({ ...alias, since: "2026-09-01" })),
    } satisfies Contract.ContractSurface;
    expect(
      Contract.classifyContractChange({ baseline, candidate: reset, now: "2026-09-01" }).accepted,
    ).toBe(false);
  });

  it("requires an envelope version bump for field changes", async () => {
    const baseline = await surface(1);
    const candidate = {
      ...baseline,
      contractVersion: 2,
      browserEnvelope: {
        ...baseline.browserEnvelope,
        eventFields: [...baseline.browserEnvelope.eventFields, "sessionId"],
      },
    } satisfies Contract.ContractSurface;
    const rejected = Contract.classifyContractChange({ baseline, candidate, now: "2026-09-01" });
    expect(rejected.accepted).toBe(false);
    const accepted = Contract.classifyContractChange({
      baseline,
      candidate: { ...candidate, browserEnvelope: { ...candidate.browserEnvelope, version: 2 } },
      now: "2026-09-01",
    });
    expect(
      accepted.findings.some((entry) => entry.code === "OBS_COMPAT_BROWSER_ENVELOPE_CHANGED"),
    ).toBe(false);
  });
});
