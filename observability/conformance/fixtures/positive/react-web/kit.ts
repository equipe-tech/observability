import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Effect, Option, Schema } from "effect";
import {
  Contract,
  CorrelationContext,
  defineTelemetryContract,
  generateRunId,
  makeEventProducer,
  parseNodeObservabilityConfig,
  parseRequestId,
  type DataPolicyInput,
  type EmitReceipt,
} from "@equipe-tech/observability";
import { createNodeObservabilityFromConfig } from "@equipe-tech/observability/node";
import {
  conformanceTargetBinding,
  contractConformance,
  correlationConformance,
  identityConformance,
  policyConformance,
  producersConformance,
  profileConformance,
  runConformance,
  telemetryCanaryConformance,
  makeCollectingTelemetryEventSink,
  type ConformanceProfileReport,
  type ConformanceTarget,
  type ConformanceTargetBinding,
  type TelemetryDestinationReceipt,
} from "@equipe-tech/observability/testing";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { createBrowserEventsController } from "@equipe-tech/observability-nestjs";
import {
  createBrowserObservability,
  runBrowserDeliveryCanary,
  type BrowserDeliveryCanaryReceipt,
  type BrowserLifecycleReport,
} from "@equipe-tech/observability-react";
import {
  browserLifecycleConformance,
  browserRouteCanaryConformance,
} from "@equipe-tech/observability-react/testing";
import {
  operationsManifestConformance,
  packageBoundaryConformance,
} from "@equipe-tech/observability-cli/testing";
import { fileURLToPath } from "node:url";
import { fixtureError } from "../../../support/FixtureError.ts";
import { startLocalCollector } from "../../../support/collector.ts";
import { parseFixtureManifest } from "../../../support/manifest.ts";

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

export const reactContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    ReactRendered: {
      name: "react.rendered",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {
        "fixture.run_id": { classification: "public", required: true, metricLabel: false },
      },
    },
  },
  metrics: {
    ReactRenderCount: {
      name: "react.render_count",
      description: "Completed React renders",
      unit: "1",
      kind: "counter",
      attributes: {
        "fixture.run_id": { classification: "public", maximumCardinality: 100 },
      },
    },
  },
  auditActions: {},
});

export const reactPolicy: DataPolicyInput = {
  attributes: {
    "fixture.run_id": { classification: "public", required: true, metricLabel: true },
  },
  blockedKeys: [],
  blockedValuePatterns: [],
};

export type ReactKit = {
  readonly emitReceipt: EmitReceipt;
  readonly correlation: CorrelationContext;
  readonly canaryReceipt: BrowserDeliveryCanaryReceipt;
  readonly lifecycleReport: BrowserLifecycleReport;
  readonly binding: ConformanceTargetBinding;
  readonly runId: string;
  readonly destinationReceipt: TelemetryDestinationReceipt;
};

export const buildReactKit = async (): Promise<ReactKit> => {
  const collector = await startLocalCollector();
  try {
    const contract = await Effect.runPromise(defineTelemetryContract(reactContractInput));
    const binding = conformanceTargetBinding(contract, {
      serviceName: "fixture-web",
      serviceVersion: "1.4.0",
      environment: "test",
    });
    const runId = await Effect.runPromise(generateRunId("canary", "fixture-web"));
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "nestjs-api",
        service: { name: "fixture-web", version: "1.4.0", environment: "test" },
        telemetry: { endpoint: collector.endpoint },
        evlog: { contract, policy: reactPolicy },
        sentry: { enabled: false },
      }),
    );
    const evlog = evlogAdapter({ installGlobalLogger: false });
    const node = await createNodeObservabilityFromConfig(config, [evlog.registration]);
    try {
      if (!node.enabled) throw fixtureError("The React fixture requires an enabled Nest runtime.");
      class ReactFixtureModule {}
      Module({
        controllers: [createBrowserEventsController(node.runtime, { eventLayer: node.eventLayer })],
      })(ReactFixtureModule);
      const app = await NestFactory.create(ReactFixtureModule, { logger: false });
      try {
        await app.listen(0, "127.0.0.1");
        const address = decodeAddressInfo(app.getHttpServer().address());
        if (Option.isNone(address))
          throw fixtureError("The React fixture Nest listener has no port.");
        const endpoint = new URL(`http://127.0.0.1:${address.value.port}/_telemetry/events`);
        const browser = createBrowserObservability({
          service: { name: "fixture-web", version: "1.4.0", environment: "test" },
          policy: reactPolicy,
          events: { endpoint: endpoint.href, flushIntervalMs: 60_000 },
          metrics: true,
          sentry: { disabled: true },
          host: {
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
        });
        if (!browser.installed)
          throw fixtureError("The React fixture requires an installed runtime.");
        let lifecycleReport: BrowserLifecycleReport | undefined;
        let canaryReceipt: BrowserDeliveryCanaryReceipt | undefined;
        try {
          const root = browser.traces.startSpan("page.load", { "fixture.run_id": runId });
          const child = browser.traces.startSpan(
            "react.render",
            { "fixture.run_id": runId },
            root.context,
          );
          browser.events.emit("react.rendered", { "fixture.run_id": runId }, child.context);
          browser.metrics.counter("react.render_count").add(1, { "fixture.run_id": runId });
          child.end();
          root.end();
          await browser.flush();
          canaryReceipt = await runBrowserDeliveryCanary({ endpoint, topology: "local" });
        } finally {
          lifecycleReport = await browser.dispose();
        }
        await app.close();
        await node.close();
        await collector.awaitDestination(runId, "fixture.run_id");
        const correlation = new CorrelationContext({
          requestId: Option.some(await Effect.runPromise(parseRequestId("fixture-request-1"))),
        });
        if (lifecycleReport === undefined || canaryReceipt === undefined) {
          throw fixtureError("The React fixture did not complete browser delivery and disposal.");
        }
        const sink = await Effect.runPromise(makeCollectingTelemetryEventSink());
        const emitReceipt = await Effect.runPromise(
          makeEventProducer(contract)
            .emit("ReactRendered", {
              outcome: "success",
              durationMs: 1,
              attributes: { "fixture.run_id": runId },
            })
            .pipe(Effect.provide(sink.layer)),
        );
        return {
          emitReceipt,
          correlation,
          canaryReceipt,
          lifecycleReport,
          binding,
          runId,
          destinationReceipt: collector.destinationReceipt(runId, binding),
        };
      } finally {
        await app.close();
      }
    } finally {
      await node.close();
    }
  } finally {
    await collector.stop();
  }
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
      metrics: true,
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
      telemetryCanaryConformance({
        runId: kit.runId,
        receipt: kit.destinationReceipt,
        eventRunIdAttribute: "fixture.run_id",
        metricRunIdAttribute: "fixture.run_id",
      }),
      browserRouteCanaryConformance({ receipt: kit.canaryReceipt }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};
