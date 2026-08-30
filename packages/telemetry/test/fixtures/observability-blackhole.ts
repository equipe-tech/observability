import { Effect, Layer, Option } from "effect";
import type { EventName } from "../../src/contract/EventName.ts";
import type {
  CompiledAuditActionDefinition,
  CompiledEventDefinition,
} from "../../src/contract/TelemetryContract.ts";
import {
  AdapterName,
  registerOfficialAdapter,
  type ContractRegistry,
} from "../../src/profile/ObservabilityAdapter.ts";
import { createNodeObservability } from "../../src/node/Observability.ts";
import { TelemetryEventSink } from "../../src/contract/EventProducer.ts";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint === undefined) throw new Error("Missing blackhole endpoint.");

const contract: ContractRegistry = {
  version: 1,
  eventNames: [],
  eventByAlias: new Map<string, CompiledEventDefinition>(),
  eventByName: new Map<EventName, CompiledEventDefinition>(),
  auditActionByAlias: new Map<string, CompiledAuditActionDefinition>(),
  auditActionByName: new Map<string, CompiledAuditActionDefinition>(),
};

const events = registerOfficialAdapter({
  name: AdapterName.make("blackhole-events"),
  capability: "events",
  stage: "server",
  start: () =>
    Effect.succeed({
      flush: Effect.void,
      close: Effect.void,
      eventLayer: Option.some(
        Layer.succeed(
          TelemetryEventSink,
          TelemetryEventSink.of({ record: () => Effect.void, recordBrowser: () => Effect.void }),
        ),
      ),
      degraded: () => false,
    }),
});

const handle = await createNodeObservability({
  profile: "worker",
  env: {
    OTEL_SERVICE_NAME: "blackhole-worker",
    OTEL_SERVICE_VERSION: "1.4.0",
    OTEL_DEPLOYMENT_ENVIRONMENT: "test",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  },
  contract,
  policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
  adapters: [events],
});
if (!handle.enabled) throw new Error("Expected an enabled runtime.");

await handle.runtime.runPromise(Effect.logInfo("blackhole application work completed"));
process.stdout.write("WORK_COMPLETED\n");
const startedAt = Date.now();
const report = await handle.close();
process.stdout.write(
  `${JSON.stringify({
    closeMillis: Date.now() - startedAt,
    activeTimeouts: process.getActiveResourcesInfo().filter((resource) => resource === "Timeout")
      .length,
    report,
  })}\n`,
);
