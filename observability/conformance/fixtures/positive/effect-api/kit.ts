import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import {
  CorrelationContext,
  Contract,
  CurrentCorrelation,
  defineTelemetryContract,
  generateRunId,
  makeEventProducer,
  makeMetricProducer,
  parseNodeObservabilityConfig,
  parseResourceIdentity,
  type DataPolicyInput,
  type EmitReceipt,
  type LifecycleReport,
  type ResourceIdentity,
} from "@equipe-tech/observability";
import { NodeObservabilityService } from "@equipe-tech/observability/node";
import {
  effectEventsAdapter,
  httpTelemetry,
  layerObservabilityFromConfig,
} from "@equipe-tech/observability-effect";
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
  type CapturedTelemetry,
  type ConformanceEvidenceProvider,
  type ConformanceProfileReport,
  type ConformanceTarget,
  type ConformanceTargetBinding,
  type OtlpCaptureServer,
  type TelemetryDestinationReceipt,
} from "@equipe-tech/observability/testing";
import {
  operationsManifestConformance,
  packageBoundaryConformance,
} from "@equipe-tech/observability-cli/testing";
import { fileURLToPath } from "node:url";
import { fixtureError } from "../../../support/FixtureError.ts";
import { startLocalCollector, type LocalCollector } from "../../../support/collector.ts";
import { parseFixtureManifest } from "../../../support/manifest.ts";

export const effectApiContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    ItemRead: {
      name: "item.read",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {
    ItemReads: {
      name: "item.reads",
      description: "Completed fixture item reads",
      unit: "1",
      kind: "counter",
      attributes: {
        "fixture.run_id": { classification: "internal", maximumCardinality: 100 },
      },
    },
  },
  auditActions: {},
});

export const effectApiPolicy: DataPolicyInput = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
};

const identityInput = {
  serviceName: "fixture-effect-api",
  serviceVersion: "1.4.0",
  environment: "test",
} as const;

export type EffectApiKit = {
  readonly identity: ResourceIdentity;
  readonly emitReceipt: EmitReceipt;
  readonly correlation: CorrelationContext;
  readonly runId: string;
  readonly lifecycleReport: LifecycleReport;
  readonly binding: ConformanceTargetBinding;
  readonly telemetry: CapturedTelemetry;
  readonly destinationReceipt?: TelemetryDestinationReceipt | undefined;
};

type RequestOutcome = {
  readonly correlation: CorrelationContext;
  readonly emitReceipt: EmitReceipt;
};

export const buildEffectApiKit = async (
  collector: OtlpCaptureServer | LocalCollector,
): Promise<EffectApiKit> => {
  try {
    const contract = await Effect.runPromise(defineTelemetryContract(effectApiContractInput));
    const identity = await Effect.runPromise(parseResourceIdentity(identityInput));
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "effect-api",
        service: {
          name: identityInput.serviceName,
          version: identityInput.serviceVersion,
          environment: identityInput.environment,
        },
        telemetry: { endpoint: collector.endpoint },
        evlog: { contract, policy: effectApiPolicy },
        sentry: { enabled: false },
      }),
    );
    const runId = await Effect.runPromise(generateRunId("job", "fixture-effect-api"));
    const producer = makeEventProducer(contract);
    let outcome: RequestOutcome | undefined;
    const routes = HttpRouter.add(
      "GET",
      "/items/:id",
      Effect.gen(function* () {
        const current = yield* CurrentCorrelation;
        const correlation = new CorrelationContext({
          trace: current.trace,
          requestId: current.requestId,
          runId: Option.some(runId),
        });
        const emitReceipt = yield* producer
          .emit("ItemRead", { outcome: "success", durationMs: 2, correlation, attributes: {} })
          .pipe(Effect.withSpan("fixture.item.read"));
        outcome = { correlation, emitReceipt };
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }),
    ).pipe(Layer.provide(httpTelemetry().layer));
    const observability = layerObservabilityFromConfig(config, [
      effectEventsAdapter().registration,
    ]);
    const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(observability),
    );
    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* NodeObservabilityService;
        if (!handle.enabled) {
          return yield* Effect.die(
            fixtureError("The effect-api fixture requires an enabled runtime."),
          );
        }
        const response = yield* HttpClient.get("/items/42");
        if (response.status !== 200) {
          return yield* Effect.die(fixtureError(`Unexpected fixture status ${response.status}.`));
        }
        makeMetricProducer(contract, handle.metrics)
          .counter("ItemReads")
          .add(1, { "fixture.run_id": runId });
        return handle;
      }).pipe(Effect.provide(server), Effect.scoped),
    );
    const lifecycleReport = await handle.close();
    if (outcome === undefined) throw fixtureError("The fixture handler did not run.");
    if ("awaitDestination" in collector) await collector.awaitDestination(runId);
    const binding = conformanceTargetBinding(contract, identityInput);
    return {
      identity,
      emitReceipt: outcome.emitReceipt,
      correlation: outcome.correlation,
      runId,
      lifecycleReport,
      binding,
      telemetry: collector.telemetry(),
      destinationReceipt:
        "destinationReceipt" in collector
          ? collector.destinationReceipt(runId, binding)
          : undefined,
    };
  } finally {
    await collector.stop();
  }
};

export const effectApiProviders = async (
  kit: EffectApiKit,
): Promise<ReadonlyArray<ConformanceEvidenceProvider>> => {
  const { manifest, contract: contractIndex } = await parseFixtureManifest(kit.binding);
  const destination = kit.destinationReceipt;
  if (destination === undefined) {
    throw fixtureError("The effect-api fixture requires Collector destination read-back.");
  }
  return [
    profileConformance({
      profile: "effect-api",
      service: {
        name: identityInput.serviceName,
        version: identityInput.serviceVersion,
        environment: identityInput.environment,
      },
    }),
    identityConformance({ identity: kit.identity }),
    contractConformance({ contract: effectApiContractInput }),
    producersConformance({ receipt: kit.emitReceipt }),
    correlationConformance({ correlation: kit.correlation }),
    policyConformance({ policy: effectApiPolicy }),
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

export const runEffectApiFixture = async (): Promise<ConformanceProfileReport> => {
  const collector = await startLocalCollector();
  const kit = await buildEffectApiKit(collector);
  const target: ConformanceTarget = {
    name: identityInput.serviceName,
    profile: "effect-api",
    environment: identityInput.environment,
    topology: "local",
    capabilities: {
      traces: true,
      metrics: true,
      defects: false,
      browserIngest: false,
      audit: false,
    },
    binding: kit.binding,
    providers: await effectApiProviders(kit),
  };
  return Effect.runPromise(runConformance(target));
};
