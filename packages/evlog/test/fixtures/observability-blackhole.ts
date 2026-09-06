import {
  Contract,
  defineTelemetryContract,
  makeEventProducer,
  parseNodeObservabilityConfig,
} from "@equipe-tech/observability";
import { createNodeObservabilityFromConfig } from "@equipe-tech/observability/node";
import { Effect } from "effect";
import { evlogAdapter } from "../../src/index.ts";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint === undefined) throw new Error("Missing blackhole endpoint.");

const contract = await Effect.runPromise(
  defineTelemetryContract(
    Contract.telemetryContractDefinition({
      version: 1,
      events: {
        completed: {
          name: "job.completed",
          kind: "operation",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "job.name": { classification: "public", required: true, metricLabel: false },
          },
        },
      },
      metrics: {},
      auditActions: {},
    }),
  ),
);
const config = await Effect.runPromise(
  parseNodeObservabilityConfig({
    enabled: true,
    profile: "worker",
    service: { name: "blackhole-worker", version: "1.4.0", environment: "test" },
    telemetry: { endpoint: new URL(endpoint) },
    evlog: { contract, policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] } },
    sentry: { enabled: false },
  }),
);
const adapter = evlogAdapter({
  installGlobalLogger: false,
  batchSize: 1,
  maximumAttempts: 1,
  transportTimeoutMillis: 100,
  transportRetries: 0,
});
const handle = await createNodeObservabilityFromConfig(config, [adapter.registration]);
if (!handle.enabled) throw new Error("Expected an enabled runtime.");

await handle.runtime.runPromise(
  makeEventProducer(contract)
    .emit("completed", {
      outcome: "success",
      durationMs: 1,
      attributes: { "job.name": "blackhole application work completed" },
    })
    .pipe(Effect.provide(handle.eventLayer)),
);
process.stdout.write("WORK_COMPLETED\n");
const startedAt = Date.now();
const report = await handle.close();
process.stdout.write(
  `${JSON.stringify({
    closeMillis: Date.now() - startedAt,
    activeTimeouts: process.getActiveResourcesInfo().filter((resource) => resource === "Timeout")
      .length,
    drops: adapter.drops(),
    report,
  })}\n`,
);
