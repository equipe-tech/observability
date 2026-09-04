import { Effect, Layer, Option } from "effect";
import {
  commitAuditRecord,
  CorrelationContext,
  Contract,
  defineTelemetryContract,
  generateRunId,
  parseResourceIdentity,
  makeEventProducer,
  makeMetricProducer,
  parseAuditRecord,
  parseNodeObservabilityConfig,
  parseSpanId,
  parseTraceId,
  withBackgroundCorrelation,
  type AuditCommitDocument,
  type DataPolicyInput,
  type ResourceIdentity,
  type EmitReceipt,
  type LifecycleReport,
  type TelemetryContractInput,
} from "@equipe-tech/observability";
import { createNodeObservabilityFromConfig } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { evlogConformance } from "@equipe-tech/observability-evlog/testing";
import {
  auditCanaryConformance,
  contractConformance,
  correlationConformance,
  identityConformance,
  lifecycleConformance,
  policyConformance,
  producersConformance,
  profileConformance,
  runConformance,
  telemetryCanaryConformance,
  type ConformanceEvidenceProvider,
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { fileURLToPath } from "node:url";
import {
  operationsManifestConformance,
  packageBoundaryConformance,
} from "@equipe-tech/observability-cli/testing";
import { startLocalCollector, type LocalCollector } from "../../../support/collector.ts";
import { parseFixtureManifest } from "../../../support/manifest.ts";

export const workerContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    SchedulerRun: {
      name: "scheduler.run",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {
    WorkerJobs: {
      name: "worker.jobs",
      description: "Completed fixture jobs",
      unit: "1",
      kind: "counter",
      attributes: {},
    },
  },
  auditActions: {},
});

export const workerPolicy: DataPolicyInput = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
};

export const buildWorkerTarget = async (collector: LocalCollector) => {
  const contract = await Effect.runPromise(defineTelemetryContract(workerContractInput));
  const identity: ResourceIdentity = await Effect.runPromise(
    parseResourceIdentity({
      serviceName: "fixture-worker",
      serviceVersion: "1.4.0",
      environment: "test",
    }),
  );
  const config = await Effect.runPromise(
    parseNodeObservabilityConfig({
      enabled: true,
      profile: "worker",
      service: { name: "fixture-worker", version: "1.4.0", environment: "test" },
      telemetry: { endpoint: collector.endpoint },
      evlog: { contract, policy: workerPolicy },
      sentry: { enabled: false },
    }),
  );
  const evlog = evlogAdapter({ installGlobalLogger: false });
  const handle = await createNodeObservabilityFromConfig(config, [evlog.registration]);
  if (!handle.enabled) throw new Error("The worker fixture requires an enabled runtime.");
  const producer = makeEventProducer(contract);
  const runId = await Effect.runPromise(generateRunId("job", "fixture"));
  const correlation = new CorrelationContext({
    trace: {
      _tag: "Traced",
      traceId: await Effect.runPromise(parseTraceId("a1b2c3d4e5f60718293a4b5c6d7e8f99")),
      spanId: await Effect.runPromise(parseSpanId("1111111111111111")),
    },
    runId: Option.some(runId),
  });
  const emitReceipt = await handle.runtime.runPromise(
    producer
      .emit("SchedulerRun", { outcome: "success", durationMs: 3, attributes: {} })
      .pipe(withBackgroundCorrelation(correlation, "fixture.job"))
      .pipe(Effect.provide(handle.eventLayer)),
  );
  makeMetricProducer(contract, handle.metrics)
    .counter("WorkerJobs")
    .add(1, {});
  const report = await handle.close();
  await collector.stop();
  return {
    identity,
    emitReceipt,
    correlation,
    runId,
    lifecycleReport: report,
    evlog,
  };
};

export type WorkerKit = {
  readonly identity: ResourceIdentity;
  readonly emitReceipt: EmitReceipt;
  readonly correlation: CorrelationContext;
  readonly runId: string;
  readonly lifecycleReport: LifecycleReport;
  readonly evlog: ReturnType<typeof evlogAdapter>;
};

export const workerProviders = async (
  kit: WorkerKit,
  collector: LocalCollector,
): Promise<ReadonlyArray<ConformanceEvidenceProvider>> => {
  const { manifest, contract: contractIndex } = await parseFixtureManifest();
  return [
  profileConformance({
    profile: "worker",
    service: { name: "fixture-worker", version: "1.4.0", environment: "test" },
  }),
  identityConformance({ identity: kit.identity }),
  contractConformance({ contract: workerContractInput }),
  producersConformance({ receipt: kit.emitReceipt }),
  correlationConformance({ correlation: kit.correlation }),
  policyConformance({ policy: workerPolicy }),
  evlogConformance({ registration: kit.evlog.registration, drops: kit.evlog.drops() }),
  ...operationsManifestConformance({ manifest, contract: contractIndex }),
  packageBoundaryConformance({
    projectRoot: fileURLToPath(new URL(".", import.meta.url)),
    sourceRoots: ["."],
  }),
  lifecycleConformance({ report: kit.lifecycleReport }),
  telemetryCanaryConformance({ runId: kit.runId, telemetry: collector.telemetry() }),
  ];
};

export const runWorkerFixture = async (): Promise<ConformanceProfileReport> => {
  const collector = await startLocalCollector();
  const kit = await buildWorkerTarget(collector);
  const target: ConformanceTarget = {
    name: "fixture-worker",
    profile: "worker",
    environment: "test",
    topology: "local",
    capabilities: { traces: true, metrics: true, defects: false, browserIngest: false, audit: false },
    providers: await workerProviders(kit, collector),
  };
  return Effect.runPromise(runConformance(target));
};
