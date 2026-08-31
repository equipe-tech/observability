import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { Contract, defineTelemetryContract } from "../src/index.ts";

describe("contract index", () => {
  it("projects and encodes signals deterministically", async () => {
    const contract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
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
                metricLabel: false,
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
            attributes: {},
          },
        },
        auditActions: {},
      }),
    );
    const index = Contract.contractIndex(contract, "checkout", {
      version: 1,
      aliases: [
        {
          source: { kind: "event", name: "payment.charge" },
          target: { kind: "event", name: "payment.attempt" },
        },
      ],
    });
    expect(index.events).toEqual([
      {
        name: "payment.attempt",
        kind: "operation",
        attributes: ["payment.provider"],
        attributeClassifications: [{ name: "payment.provider", classification: "public" }],
      },
    ]);
    expect(index.metrics).toEqual([
      {
        name: "payment.latency",
        kind: "histogram",
        unit: "ms",
        attributes: [],
      },
    ]);
    expect(index.aliases).toEqual([
      { kind: "event", from: "payment.charge", to: "payment.attempt" },
    ]);
    expect(Contract.encodeContractIndex(index)).toBe(`${JSON.stringify(index, null, 2)}\n`);
  });

  it("indexes 1000 alias sources within a bounded runtime", async () => {
    const contract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: {
          Target: {
            name: "graph.target",
            kind: "operation",
            defaultSeverity: "info",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {},
          },
        },
        metrics: {},
        auditActions: {},
      }),
    );
    const aliases: Array<Contract.ContractSignalAliasDefinition> = Array.from(
      { length: 1_000 },
      (_, index) => ({
        source: { kind: "event", name: `legacy.node_${String(index).padStart(4, "0")}` },
        target: { kind: "event", name: "graph.target" },
      }),
    );
    const startedAt = performance.now();
    const index = Contract.contractIndex(contract, "graph", { version: 1, aliases });
    expect(index.aliases).toHaveLength(1_000);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("expands compatible sources and rejects invalid, incompatible and cyclic aliases", async () => {
    const contract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: {
          First: {
            name: "payment.first",
            kind: "operation",
            defaultSeverity: "info",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {
              "payment.provider": {
                classification: "public",
                required: true,
                metricLabel: false,
              },
            },
          },
          Second: {
            name: "payment.second",
            kind: "operation",
            defaultSeverity: "info",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {
              "payment.provider": {
                classification: "internal",
                required: true,
                metricLabel: false,
              },
            },
          },
        },
        metrics: {
          Duration: {
            name: "payment.duration",
            description: "Payment duration",
            unit: "ms",
            kind: "histogram",
            boundaries: [10, 100],
            attributes: {},
          },
          Count: {
            name: "payment.count_total",
            description: "Payment count",
            unit: "1",
            kind: "counter",
            attributes: {},
          },
        },
        auditActions: {},
      }),
    );
    expect(() =>
      Contract.contractIndex(contract, "checkout", {
        version: 1,
        aliases: [
          {
            source: { kind: "metric", name: "payment.old" },
            target: { kind: "event", name: "payment.first" },
          },
        ],
      }),
    ).toThrow("kinds must match");
    const eventAlias = (
      source: string,
      target: string,
    ): Contract.ContractSignalAliasDefinition => ({
      source: { kind: "event", name: source },
      target: { kind: "event", name: target },
    });
    for (const aliases of [
      [eventAlias("payment.old", "payment.first"), eventAlias("payment.old", "payment.second")],
      [eventAlias("payment.old", "payment.first"), eventAlias("payment.first", "payment.second")],
    ]) {
      expect(() => Contract.contractIndex(contract, "checkout", { version: 1, aliases })).toThrow(
        "incompatible attributes or classifications",
      );
    }
    const metricAlias = (
      source: string,
      target: string,
    ): Contract.ContractSignalAliasDefinition => ({
      source: { kind: "metric", name: source },
      target: { kind: "metric", name: target },
    });
    for (const aliases of [
      [
        metricAlias("payment.old", "payment.duration"),
        metricAlias("payment.old", "payment.count_total"),
      ],
      [
        metricAlias("payment.old", "payment.duration"),
        metricAlias("payment.duration", "payment.count_total"),
      ],
    ]) {
      expect(() => Contract.contractIndex(contract, "checkout", { version: 1, aliases })).toThrow(
        "incompatible kind, unit, or attributes",
      );
    }
    expect(() =>
      Contract.contractIndex(contract, "checkout", {
        version: 1,
        aliases: [
          {
            source: { kind: "event", name: "payment.first" },
            target: { kind: "event", name: "payment.second" },
          },
          {
            source: { kind: "event", name: "payment.second" },
            target: { kind: "event", name: "payment.first" },
          },
        ],
      }),
    ).toThrow("cycle");
  });
});
