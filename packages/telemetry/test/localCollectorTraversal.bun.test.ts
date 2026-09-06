import { describe, expect, test } from "bun:test";
import {
  startLocalCollectorDestination,
  telemetryDestinationTelemetry,
  type ConformanceTargetBinding,
} from "../src/testing/index.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"]).exitCode === 0;
const collectorTest = dockerAvailable ? test : test.skip;

const otlpLog = (runId: string) => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "collector-proof" } },
          { key: "service.version", value: { stringValue: "1.0.0" } },
          { key: "deployment.environment.name", value: { stringValue: "test" } },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              body: { stringValue: "collector traversal" },
              attributes: [{ key: "run.id", value: { stringValue: runId } }],
            },
          ],
        },
      ],
    },
  ],
});

const sendLog = async (endpoint: URL, runId: string): Promise<void> => {
  const response = await fetch(new URL("/v1/logs", endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otlpLog(runId)),
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
};

describe("local Collector traversal evidence", () => {
  collectorTest(
    "rejects destination read-back from telemetry that bypassed the Collector",
    async () => {
      const collector = await startLocalCollectorDestination();
      const binding: ConformanceTargetBinding = {
        identity: {
          serviceName: "collector-proof",
          serviceVersion: "1.0.0",
          environment: "test",
        },
        contract: {
          index: 1,
          contractVersion: 1,
          service: "collector-proof",
          events: [],
          metrics: [],
          aliases: [],
        },
        producerContractProvenance: "collector-proof-contract",
      };
      try {
        const bypassRunId = `bypass-${crypto.randomUUID()}`;
        await sendLog(collector.destinationEndpoint, bypassRunId);
        const bypassReceipt = collector.destinationReceipt(bypassRunId, binding);
        expect(telemetryDestinationTelemetry(bypassReceipt)?.logs).toHaveLength(0);

        const traversedRunId = `traversed-${crypto.randomUUID()}`;
        await sendLog(collector.endpoint, traversedRunId);
        await collector.awaitDestination(traversedRunId);
        const traversedReceipt = collector.destinationReceipt(traversedRunId, binding);
        expect(telemetryDestinationTelemetry(traversedReceipt)?.logs).toHaveLength(1);
      } finally {
        await collector.stop();
      }
    },
  );
});
