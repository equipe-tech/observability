import { Effect, Option } from "effect";
import {
  Contract,
  CorrelationContext,
  defineTelemetryContract,
  makeEventProducer,
  parseRequestId,
  type DataPolicyInput,
  type EmitReceipt,
} from "@equipe-tech/observability";
import { makeCollectingTelemetryEventSink } from "@equipe-tech/observability/testing";
import {
  createBrowserObservability,
  runBrowserDeliveryCanary,
} from "@equipe-tech/observability-react";
import {
  browserLifecycleConformance,
  browserRouteCanaryConformance,
} from "@equipe-tech/observability-react/testing";
import {
  operationsManifestConformance,
  packageBoundaryConformance,
} from "@equipe-tech/observability-cli/testing";
import {
  contractConformance,
  conformanceTargetBinding,
  correlationConformance,
  identityConformance,
  policyConformance,
  producersConformance,
  profileConformance,
  runConformance,
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { fileURLToPath } from "node:url";
import { fixtureError } from "../../../support/FixtureError.ts";
import { parseFixtureManifest } from "../../../support/manifest.ts";

export const reactContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    ...Contract.organizationEvents,
    UsageRecorded: Contract.organizationEvents.UsageRecorded,
  },
  metrics: {},
  auditActions: {},
});

export const reactPolicy: DataPolicyInput = {
  attributes: { "usage.type": { classification: "internal", required: true, metricLabel: false } },
  blockedKeys: [],
  blockedValuePatterns: [],
};

export type ReactKit = {
  readonly emitReceipt: EmitReceipt;
  readonly correlation: CorrelationContext;
  readonly canaryReceipt: {
    readonly endpointOrigin: string;
    readonly status: 202;
    readonly durationMillis: number;
  };
  readonly lifecycleReport: { readonly durationMillis: number; readonly degraded: boolean };
  readonly binding: import("@equipe-tech/observability/testing").ConformanceTargetBinding;
};

export const buildReactKit = async (): Promise<ReactKit> => {
  const contract = await Effect.runPromise(defineTelemetryContract(reactContractInput));
  const correlation = new CorrelationContext({
    requestId: Option.some(await Effect.runPromise(parseRequestId("fixture-request-1"))),
  });
  const sink = await Effect.runPromise(makeCollectingTelemetryEventSink());
  const producer = makeEventProducer(contract);
  const emitReceipt = await Effect.runPromise(
    producer
      .emit("UsageRecorded", {
        outcome: "success",
        attributes: { "usage.type": "fixture", "usage.unit": "run" },
      })
      .pipe(Effect.provide(sink.layer)),
  );
  const events: Array<{ readonly name: string }> = [];
  const browser = createBrowserObservability({
    service: { name: "fixture-web", version: "1.4.0", environment: "test" },
    policy: reactPolicy,
    events: {
      transport: async () => {
        events.push({ name: "delivered" });
        return;
      },
    },
    sentry: { disabled: true },
    host: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  if (!browser.installed) {
    throw fixtureError("The react fixture requires an installed runtime.");
  }
  browser.events.emit("usage.recorded", { "usage.type": "fixture", "usage.unit": "run" });
  const defect = browser.defects.report({
    error: new Error("fixture browser defect"),
    origin: "manual",
  });
  if (defect.kind !== "recorded") {
    throw fixtureError(`The react fixture defect report was ${defect.kind}.`);
  }
  await browser.flush();
  const canaryReceipt = await runBrowserDeliveryCanary({
    endpoint: new URL("https://ingest.fixture.example/api/v2/observability/browser-events"),
    transport: async () => new Response("{}", { status: 202 }),
  });
  const lifecycleReport = await browser.dispose();
  return {
    emitReceipt,
    correlation,
    canaryReceipt,
    lifecycleReport,
    binding: conformanceTargetBinding(contract, {
      serviceName: "fixture-web",
      serviceVersion: "1.4.0",
      environment: "test",
    }),
  };
};

export const runReactFixture = async (): Promise<ConformanceProfileReport> => {
  const kit = await buildReactKit();
  const { manifest, contract: contractIndex } = await parseFixtureManifest(kit.binding);
  const target: ConformanceTarget = {
    name: "fixture-web",
    profile: "react-web",
    environment: "test",
    topology: "local",
    capabilities: {
      traces: true,
      metrics: false,
      defects: false,
      browserIngest: true,
      audit: false,
    },
    binding: kit.binding,
    providers: [
      profileConformance({
        profile: "react-web",
        service: { name: "fixture-web", version: "1.4.0", environment: "test" },
      }),
      identityConformance({
        identity: { serviceName: "fixture-web", serviceVersion: "1.4.0", environment: "test" },
      }),
      contractConformance({ contract: reactContractInput }),
      producersConformance({ receipt: kit.emitReceipt }),
      correlationConformance({ correlation: kit.correlation }),
      policyConformance({ policy: reactPolicy }),
      ...operationsManifestConformance({ manifest, contract: contractIndex }),
      packageBoundaryConformance({
        projectRoot: fileURLToPath(new URL(".", import.meta.url)),
        sourceRoots: ["."],
      }),
      browserLifecycleConformance({
        report: kit.lifecycleReport,
        service: { name: "fixture-web", environment: "test" },
      }),
      browserRouteCanaryConformance({ receipt: kit.canaryReceipt }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};
