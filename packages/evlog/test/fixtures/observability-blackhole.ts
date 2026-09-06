import {
  Contract,
  AuditPublisher,
  commitAuditRecord,
  parseAuditRecord,
  defineTelemetryContract,
  makeEventProducer,
  parseNodeObservabilityConfig,
} from "@equipe-tech/observability";
import {
  createNodeObservabilityFromConfig,
  layerNodeAuditDigest,
} from "@equipe-tech/observability/node";
import { Effect } from "effect";
import { evlogAdapter } from "../../src/index.ts";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint === undefined) throw new Error("Missing blackhole endpoint.");

const contract = await Effect.runPromise(
  defineTelemetryContract(
    Contract.telemetryContractDefinition({
      version: 1,
      events: {
        AuditRecorded: Contract.organizationEvents.AuditRecorded,
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
      auditActions: {
        JobCompleted: {
          action: "job.completed",
          resourceType: "job",
          allowedOutcomes: ["success"],
        },
      },
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
const adapter =
  process.env.EVLOG_TEST_SHORT_TIMEOUT === "1"
    ? evlogAdapter({
        installGlobalLogger: false,
        batchSize: 1,
        maximumAttempts: 1,
        transportTimeoutMillis: 100,
        transportRetries: 0,
      })
    : evlogAdapter();
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
const publisher = await handle.runtime.runPromise(
  AuditPublisher.pipe(Effect.provide(handle.auditLayer)),
);
const record = await Effect.runPromise(
  parseAuditRecord(contract, {
    recordId: "blackhole-audit",
    action: "job.completed",
    actor: { kind: "system" },
    resource: { id: "blackhole-job" },
    outcome: "success",
    occurredAt: "2026-01-02T03:04:05.000Z",
  }),
);
const committed = await Effect.runPromise(
  commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
);
await Effect.runPromise(publisher.publish(committed.record));
const duplicate = Effect.runPromise(publisher.publish(committed.record));
process.stdout.write("WORK_COMPLETED\n");
const startedAt = Date.now();
const report = await handle.close();
process.stdout.write(
  `${JSON.stringify({
    duplicate: await duplicate,
    audit: publisher.report(),
    closeMillis: Date.now() - startedAt,
    activeTimeouts: process.getActiveResourcesInfo().filter((resource) => resource === "Timeout")
      .length,
    drops: adapter.drops(),
    pending: adapter.pending(),
    report,
  })}\n`,
);

const fresh = evlogAdapter();
const restarted = await createNodeObservabilityFromConfig(config, [fresh.registration]);
process.stdout.write("RESTART_OK\n");
await restarted.close();
