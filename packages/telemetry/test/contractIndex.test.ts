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
            attributes: {},
          },
          Second: {
            name: "payment.second",
            kind: "operation",
            defaultSeverity: "info",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {},
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
    expect(
      Contract.contractIndex(contract, "checkout", {
        version: 1,
        aliases: [
          {
            source: { kind: "event", name: "payment.old" },
            target: { kind: "event", name: "payment.first" },
          },
          {
            source: { kind: "event", name: "payment.old" },
            target: { kind: "event", name: "payment.second" },
          },
        ],
      }).aliases,
    ).toHaveLength(2);
    expect(() =>
      Contract.contractIndex(contract, "checkout", {
        version: 1,
        aliases: [
          {
            source: { kind: "metric", name: "payment.old" },
            target: { kind: "metric", name: "payment.duration" },
          },
          {
            source: { kind: "metric", name: "payment.old" },
            target: { kind: "metric", name: "payment.count_total" },
          },
        ],
      }),
    ).toThrow("incompatible kind, unit, or attributes");
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
