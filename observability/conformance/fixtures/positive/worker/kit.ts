import { Effect, Option } from "effect";
import {
  CorrelationContext,
  Contract,
  defineTelemetryContract,
  generateRunId,
  parseResourceIdentity,
  makeEventProducer,
  makeMetricProducer,
  parseNodeObservabilityConfig,
  parseSpanId,
  parseTraceId,
  withBackgroundCorrelation,
  type DataPolicyInput,
  type ResourceIdentity,
  type EmitReceipt,
  type LifecycleReport,
} from "@equipe-tech/observability";
import {
  createNodeObservabilityFromConfig,
  type NodeObservability,
} from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { evlogConformance } from "@equipe-tech/observability-evlog/testing";
import {
  contractConformance,
  conformanceTargetBinding,
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
import type { OtlpCaptureServer } from "@equipe-tech/observability/testing";
import { fixtureError } from "../../../support/FixtureError.ts";
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
      attributes: {
        "fixture.run_id": { classification: "internal", maximumCardinality: 100 },
      },
    },
  },
  auditActions: {},
});

export const workerPolicy: DataPolicyInput = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
};

export const buildWorkerTarget = async (
  collector: OtlpCaptureServer | LocalCollector,
  options: {
    readonly lifecycleOperation?: "close" | "flush" | undefined;
    readonly failAfterStart?: boolean | undefined;
    readonly onStarted?: ((handle: NodeObservability) => void) | undefined;
  } = {},
) => {
  try {
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
    try {
      if (!handle.enabled) throw fixtureError("The worker fixture requires an enabled runtime.");
      options.onStarted?.(handle);
      if (options.failAfterStart === true) {
        throw fixtureError("The worker fixture failed after runtime startup.");
      }
      const producer = makeEventProducer(contract);
      const runId = await Effect.runPromise(generateRunId("job", "fixture"));
      const { correlation, emitReceipt } = await handle.runtime.runPromise(
        Effect.gen(function* () {
          const root = yield* Effect.currentSpan;
          const correlation = new CorrelationContext({
            trace: {
              _tag: "Traced",
              traceId: yield* parseTraceId(root.traceId),
              spanId: yield* parseSpanId(root.spanId),
            },
            runId: Option.some(runId),
          });
          const emitReceipt = yield* producer
            .emit("SchedulerRun", { outcome: "success", durationMs: 3, attributes: {} })
            .pipe(withBackgroundCorrelation(correlation, "fixture.job"));
          return { correlation, emitReceipt };
        }).pipe(Effect.withSpan("fixture.root"), Effect.provide(handle.eventLayer)),
      );
      makeMetricProducer(contract, handle.metrics)
        .counter("WorkerJobs")
        .add(1, { "fixture.run_id": runId });
      const report = await handle[options.lifecycleOperation ?? "close"]();
      if ("awaitDestination" in collector) await collector.awaitDestination(runId);
      return {
        identity,
        emitReceipt,
        correlation,
        runId,
        lifecycleReport: report,
        evlog,
        binding: conformanceTargetBinding(contract, identity),
        telemetry: collector.telemetry(),
        destinationReceipt:
          "destinationReceipt" in collector
            ? collector.destinationReceipt(runId, conformanceTargetBinding(contract, identity))
            : undefined,
      };
    } finally {
      await handle.close();
    }
  } finally {
    await collector.stop();
  }
};

export type WorkerKit = {
  readonly identity: ResourceIdentity;
  readonly emitReceipt: EmitReceipt;
  readonly correlation: CorrelationContext;
  readonly runId: string;
  readonly lifecycleReport: LifecycleReport;
  readonly evlog: ReturnType<typeof evlogAdapter>;
  readonly binding: import("@equipe-tech/observability/testing").ConformanceTargetBinding;
  readonly telemetry: import("@equipe-tech/observability/testing").CapturedTelemetry;
  readonly destinationReceipt?:
    | import("@equipe-tech/observability/testing").TelemetryDestinationReceipt
    | undefined;
};

export const workerProviders = async (
  kit: WorkerKit,
): Promise<ReadonlyArray<ConformanceEvidenceProvider>> => {
  const { manifest, contract: contractIndex } = await parseFixtureManifest(kit.binding);
  const destination = kit.destinationReceipt;
  if (destination === undefined) {
    throw fixtureError("The worker fixture requires Collector destination read-back.");
  }
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
    evlogConformance({
      delivery: Option.getOrThrow(kit.evlog.delivery(kit.runId, "scheduler.run")),
      drops: kit.evlog.drops(),
      destination,
      runId: kit.runId,
      eventName: "scheduler.run",
    }),
    ...operationsManifestConformance({ manifest, contract: contractIndex }),
    packageBoundaryConformance({
      projectRoot: fileURLToPath(new URL(".", import.meta.url)),
      sourceRoots: ["."],
    }),
    lifecycleConformance({ report: kit.lifecycleReport }),
    telemetryCanaryConformance({
      runId: kit.runId,
      receipt: destination,
      metricRunIdAttribute: "fixture.run_id",
    }),
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
    capabilities: {
      traces: true,
      metrics: true,
      defects: false,
      browserIngest: false,
      audit: false,
    },
    binding: kit.binding,
    providers: await workerProviders(kit),
  };
  return Effect.runPromise(runConformance(target));
};
