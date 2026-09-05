import { Effect, Layer, Option } from "effect";
import {
  Contract,
  CorrelationContext,
  defineTelemetryContract,
  generateRunId,
  makeEventProducer,
  makeMetricProducer,
  parseAuditRecord,
  parseNodeObservabilityConfig,
  parseSpanId,
  parseTraceId,
  recordAudit,
  unexpectedDefect,
  withBackgroundCorrelation,
  type AuditCommitDocument,
  type AuditPublisher,
  type DataPolicyInput,
  type EmitReceipt,
  type LifecycleReport,
  type RecordAuditResult,
  type TelemetryContract,
  type TelemetryContractInput,
} from "@equipe-tech/observability";
import {
  createNodeObservabilityFromConfig,
  layerNodeAuditDigest,
} from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { evlogConformance } from "@equipe-tech/observability-evlog/testing";
import { sentryDefectAdapter } from "@equipe-tech/observability-sentry/node";
import {
  sentryCanaryConformance,
  type SentryCaptureOutcome,
  type SentryVerificationReceipt,
} from "@equipe-tech/observability-sentry/testing";
import { NestErrorBoundary } from "@equipe-tech/observability-nestjs";
import { nestjsDefectBoundaryConformance } from "@equipe-tech/observability-nestjs/testing";
import {
  operationsManifestConformance,
  packageBoundaryConformance,
} from "@equipe-tech/observability-cli/testing";
import type { ConformanceEvidenceProvider } from "@equipe-tech/observability/testing";
import type { OperationsManifest, OperationsContractIndex } from "@equipe-tech/observability-cli";
import {
  auditCanaryConformance,
  auditConformance,
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
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { defineErrorCatalog } from "evlog";
import { fileURLToPath } from "node:url";
import { startOtlpCaptureServer, type OtlpCaptureServer } from "@equipe-tech/observability/testing";
import { fixtureError } from "../../../support/FixtureError.ts";
import { parseFixtureManifest } from "../../../support/manifest.ts";

export const nestjsContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    ...Contract.organizationEvents,
  },
  metrics: {
    FixtureRequests: {
      name: "fixture.requests",
      description: "Fixture requests",
      unit: "1",
      kind: "counter",
      attributes: {
        "fixture.run_id": { classification: "internal", maximumCardinality: 100 },
      },
    },
  },
  auditActions: {
    FixtureUpdated: {
      action: "fixture.updated",
      resourceType: "widget",
      allowedOutcomes: ["success", "denied"],
      reasonCodes: [],
    },
  },
});

export const nestjsPolicy: DataPolicyInput = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
};

export const nestjsCatalog = defineErrorCatalog("fixture_app", {
  APP_NOT_FOUND: { status: 404, message: "Fixture widget not found." },
});

export type NestjsKit = {
  readonly boundary: NestErrorBoundary;
  readonly evlog: ReturnType<typeof evlogAdapter>;
  readonly emitReceipt: EmitReceipt;
  readonly verification: SentryVerificationReceipt | SentryCaptureOutcome;
  readonly captureOutcome: SentryCaptureOutcome;
  readonly captureCode: string;
  readonly expectedCaptureOutcome: Option.Option<SentryCaptureOutcome>;
  readonly commit: RecordAuditResult<ReadonlyArray<AuditCommitDocument>>;
  readonly correlation: CorrelationContext;
  readonly runId: string;
  readonly lifecycleReport: LifecycleReport;
  readonly binding: import("@equipe-tech/observability/testing").ConformanceTargetBinding;
  readonly telemetry: import("@equipe-tech/observability/testing").CapturedTelemetry;
};

const recordNestjsAudit = <Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  auditLayer: Layer.Layer<AuditPublisher>,
  correlation: CorrelationContext,
) =>
  Effect.gen(function* () {
    const record = yield* parseAuditRecord(contract, {
      recordId: "fixture-audit-1",
      action: "fixture.updated",
      actor: { kind: "service", id: "fixture" },
      resource: { id: "widget-1" },
      outcome: "success",
      occurredAt: "2026-01-02T03:04:05.000Z",
      correlation,
    });
    const ledger: Array<AuditCommitDocument> = [];
    return yield* recordAudit(record, (document) =>
      Effect.sync(() => {
        ledger.push(document);
        return ledger;
      }),
    ).pipe(Effect.provide(Layer.provideMerge(auditLayer, layerNodeAuditDigest)));
  });

export const buildNestjsKit = async (
  collector: OtlpCaptureServer,
  captureExpectedError = false,
): Promise<NestjsKit> => {
  try {
    const contract = await Effect.runPromise(defineTelemetryContract(nestjsContractInput));
    const runId = await Effect.runPromise(generateRunId("job", "fixture-api"));
    const correlation = new CorrelationContext({
      trace: {
        _tag: "Traced",
        traceId: await Effect.runPromise(parseTraceId("a1b2c3d4e5f60718293a4b5c6d7e8f98")),
        spanId: await Effect.runPromise(parseSpanId("1111111111111111")),
      },
      runId: Option.some(runId),
    });
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "nestjs-api",
        service: { name: "fixture-api", version: "1.4.0", environment: "test" },
        telemetry: { endpoint: collector.endpoint },
        evlog: { contract, policy: nestjsPolicy },
        sentry: { enabled: true, dsn: new URL(`http://fixturekey@${collector.endpoint.host}/42`) },
      }),
    );
    const evlog = evlogAdapter({ installGlobalLogger: false });
    const adapter = sentryDefectAdapter();
    const handle = await createNodeObservabilityFromConfig(config, [
      evlog.registration,
      adapter.registration,
    ]);
    try {
      if (!handle.enabled) {
        throw fixtureError("The nestjs-api fixture requires an enabled runtime.");
      }
      const boundary = new NestErrorBoundary({
        catalog: nestjsCatalog,
        recordDefect: () => undefined,
        sentryDefects: { capture: (input) => adapter.capture(input) },
      });
      const expected = nestjsCatalog.APP_NOT_FOUND();
      const expectedClassification = boundary.classify(expected, correlation);
      if (expectedClassification.kind !== "expected") {
        throw fixtureError("The fixture catalog error must classify as expected.");
      }
      const expectedCaptureOutcome = captureExpectedError
        ? Option.some(
            await adapter.captureAsync({
              envelope: unexpectedDefect({
                error: expected,
                code: expectedClassification.response.body.code,
              }),
            }),
          )
        : Option.none<SentryCaptureOutcome>();
      const unexpected = new Error("fixture unexpected defect");
      const unexpectedClassification = boundary.classify(unexpected, correlation);
      if (unexpectedClassification.kind !== "unexpected") {
        throw fixtureError("The fixture defect must classify as unexpected.");
      }
      const outcome = await adapter.captureAsync({
        envelope: unexpectedDefect({ error: unexpected, code: unexpectedClassification.code }),
      });
      if (outcome.kind !== "queued") {
        throw fixtureError(`The fixture Sentry capture was ${outcome.kind}.`);
      }
      const verificationError = new Error("fixture verification defect");
      const verification = await adapter.sendVerificationDefect({
        envelope: unexpectedDefect({ error: verificationError, code: "OBS_FIXTURE_VERIFICATION" }),
      });
      const commit = await Effect.runPromise(
        recordNestjsAudit(contract, handle.auditLayer, correlation),
      );
      makeMetricProducer(contract, handle.metrics)
        .counter("FixtureRequests")
        .add(1, { "fixture.run_id": runId });
      const producer = makeEventProducer(contract);
      const emitReceipt = await handle.runtime.runPromise(
        producer
          .emit("RequestCompleted", {
            outcome: "success",
            durationMs: 4,
            http: { method: "GET", route: "/fixture", statusCode: 200 },
            attributes: {},
          })
          .pipe(withBackgroundCorrelation(correlation, "fixture.request"))
          .pipe(Effect.provide(handle.eventLayer)),
      );
      const lifecycleReport = await handle.close();
      return {
        boundary,
        evlog,
        emitReceipt,
        verification,
        captureOutcome: outcome,
        captureCode: unexpectedClassification.code,
        expectedCaptureOutcome,
        commit,
        correlation,
        runId,
        lifecycleReport,
        binding: conformanceTargetBinding(contract, {
          serviceName: "fixture-api",
          serviceVersion: "1.4.0",
          environment: "test",
        }),
        telemetry: collector.telemetry(),
      };
    } finally {
      await handle.close();
    }
  } finally {
    await collector.stop();
  }
};

export type NestjsConformance = {
  readonly kit: NestjsKit;
  readonly providers: ReadonlyArray<ConformanceEvidenceProvider>;
  readonly manifest: OperationsManifest;
  readonly contractIndex: OperationsContractIndex;
};

export const buildNestjsConformance = async (
  captureExpectedError = false,
): Promise<NestjsConformance> => {
  const collector = await startOtlpCaptureServer();
  const kit = await buildNestjsKit(collector, captureExpectedError);
  const { manifest, contract: contractIndex } = await parseFixtureManifest(kit.binding);
  const providers = [
    profileConformance({
      profile: "nestjs-api",
      service: { name: "fixture-api", version: "1.4.0", environment: "test" },
    }),
    identityConformance({
      identity: { serviceName: "fixture-api", serviceVersion: "1.4.0", environment: "test" },
    }),
    contractConformance({ contract: nestjsContractInput }),
    producersConformance({ receipt: kit.emitReceipt }),
    correlationConformance({ correlation: kit.correlation }),
    policyConformance({ policy: nestjsPolicy }),
    evlogConformance({
      registration: kit.evlog.registration,
      drops: kit.evlog.drops(),
      telemetry: kit.telemetry,
      runId: kit.runId,
      eventName: "request.completed",
    }),
    ...operationsManifestConformance({ manifest, contract: contractIndex }),
    nestjsDefectBoundaryConformance({
      boundary: kit.boundary,
      correlation: kit.correlation,
      errors: [
        { error: nestjsCatalog.APP_NOT_FOUND(), captured: false },
        { error: new Error("fixture unexpected defect"), captured: true },
      ],
    }),
    sentryCanaryConformance({ verification: kit.verification }),
    lifecycleConformance({ report: kit.lifecycleReport }),
    auditConformance({
      commit: kit.commit,
      operationalAction: "fixture.updated",
      operationalRecordId: "fixture-audit-1",
      operationalRecord: kit.commit.record,
    }),
    packageBoundaryConformance({
      projectRoot: fileURLToPath(new URL(".", import.meta.url)),
      sourceRoots: ["."],
    }),
    telemetryCanaryConformance({
      runId: kit.runId,
      telemetry: kit.telemetry,
      metricRunIdAttribute: "fixture.run_id",
    }),
    auditCanaryConformance({
      ledgerReceiptId: kit.commit.record.recordId,
      publish: kit.commit.publish,
    }),
  ];
  return { kit, providers, manifest, contractIndex };
};

export const runNestjsFixture = async (): Promise<ConformanceProfileReport> => {
  const { kit, providers } = await buildNestjsConformance();
  const target: ConformanceTarget = {
    name: "fixture-api",
    profile: "nestjs-api",
    environment: "test",
    topology: "local",
    capabilities: { traces: true, metrics: true, defects: true, browserIngest: false, audit: true },
    binding: kit.binding,
    providers,
  };
  return Effect.runPromise(runConformance(target));
};
