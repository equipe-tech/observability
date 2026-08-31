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
    const index = Contract.contractIndex(contract, "checkout");
    expect(index.events).toEqual([
      { name: "payment.attempt", kind: "operation", attributes: ["payment.provider"] },
    ]);
    expect(index.metrics).toEqual([
      { name: "payment.latency", kind: "histogram", unit: "ms", attributes: [] },
    ]);
    expect(Contract.encodeContractIndex(index)).toBe(`${JSON.stringify(index, null, 2)}\n`);
  });
});
