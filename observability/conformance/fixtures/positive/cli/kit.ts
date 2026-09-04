import { Effect, Option } from "effect";
import {
  CorrelationContext,
  Contract,
  defineTelemetryContract,
  generateRunId,
  makeEventProducer,
  parseNodeObservabilityConfig,
  parseSpanId,
  parseTraceId,
  withBackgroundCorrelation,
  type DataPolicyInput,
  type EmitReceipt,
} from "@equipe-tech/observability";
import { createNodeObservabilityFromConfig } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { evlogConformance } from "@equipe-tech/observability-evlog/testing";
import {
  contractConformance,
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
import { fileURLToPath } from "node:url";
import { startLocalCollector, type LocalCollector } from "../../../support/collector.ts";
import { packageBoundaryConformance } from "@equipe-tech/observability-cli/testing";
import { fixtureError } from "../../../support/FixtureError.ts";
import { parseFixtureManifest } from "../../../support/manifest.ts";
import { operationsManifestConformance } from "@equipe-tech/observability-cli/testing";

export const cliContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    CommandRun: {
      name: "cli.command",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {},
  auditActions: {},
});

export const cliPolicy: DataPolicyInput = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
};

export type CliKit = {
  readonly evlog: ReturnType<typeof evlogAdapter>;
  readonly emitReceipt: EmitReceipt;
  readonly correlation: CorrelationContext;
  readonly runId: string;
  readonly lifecycleReport: import("@equipe-tech/observability").LifecycleReport;
};

export const buildCliKit = async (collector: LocalCollector): Promise<CliKit> => {
  const contract = await Effect.runPromise(defineTelemetryContract(cliContractInput));
  const runId = await Effect.runPromise(generateRunId("job", "fixture-cli"));
  const correlation = new CorrelationContext({
    trace: {
      _tag: "Traced",
      traceId: await Effect.runPromise(parseTraceId("a1b2c3d4e5f60718293a4b5c6d7e8f97")),
      spanId: await Effect.runPromise(parseSpanId("1111111111111111")),
    },
    runId: Option.some(runId),
  });
  const config = await Effect.runPromise(
    parseNodeObservabilityConfig({
      enabled: true,
      profile: "cli",
      service: { name: "fixture-cli", version: "1.4.0", environment: "test" },
      telemetry: { endpoint: collector.endpoint },
      evlog: { contract, policy: cliPolicy },
      sentry: { enabled: false },
    }),
  );
  const evlog = evlogAdapter({ installGlobalLogger: false });
  const handle = await createNodeObservabilityFromConfig(config, [evlog.registration]);
  if (!handle.enabled) throw fixtureError("The cli fixture requires an enabled runtime.");
  const producer = makeEventProducer(contract);
  const emitReceipt = await handle.runtime.runPromise(
    producer
      .emit("CommandRun", { outcome: "success", durationMs: 2, attributes: {} })
      .pipe(withBackgroundCorrelation(correlation, "fixture.command"))
      .pipe(Effect.provide(handle.eventLayer)),
  );
  const lifecycleReport = await handle.close();
  await collector.stop();
  return { evlog, emitReceipt, correlation, runId, lifecycleReport };
};

export const runCliFixture = async (): Promise<ConformanceProfileReport> => {
  const collector = await startLocalCollector();
  const kit = await buildCliKit(collector);
  const { manifest, contract: contractIndex } = await parseFixtureManifest();
  const target: ConformanceTarget = {
    name: "fixture-cli",
    profile: "cli",
    environment: "test",
    topology: "local",
    capabilities: {
      traces: false,
      metrics: false,
      defects: false,
      browserIngest: false,
      audit: false,
    },
    providers: [
      profileConformance({
        profile: "cli",
        service: { name: "fixture-cli", version: "1.4.0", environment: "test" },
      }),
      identityConformance({
        identity: { serviceName: "fixture-cli", serviceVersion: "1.4.0", environment: "test" },
      }),
      contractConformance({ contract: cliContractInput }),
      producersConformance({ receipt: kit.emitReceipt }),
      correlationConformance({ correlation: kit.correlation }),
      policyConformance({ policy: cliPolicy }),
      evlogConformance({ registration: kit.evlog.registration, drops: kit.evlog.drops() }),
      ...operationsManifestConformance({ manifest, contract: contractIndex }),
      lifecycleConformance({ report: kit.lifecycleReport }),
      packageBoundaryConformance({
        projectRoot: fileURLToPath(new URL(".", import.meta.url)),
        sourceRoots: ["."],
      }),
      telemetryCanaryConformance({ runId: kit.runId, telemetry: collector.telemetry() }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};
