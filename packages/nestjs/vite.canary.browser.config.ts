import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { defineConfig, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { Contract, parseNodeObservabilityConfig } from "@equipe-tech/observability";
import { createNodeObservabilityFromConfig } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { createBrowserEventsController } from "./src/index.ts";

class BrowserSignalCanaryError extends Schema.TaggedError<BrowserSignalCanaryError>()(
  "BrowserSignalCanaryError",
  { code: Schema.Literal("OBS_BROWSER_SIGNAL_CANARY_INVALID"), message: Schema.String },
) {}

const Address = Schema.Struct({ port: Schema.Number });
const Environment = Schema.Struct({
  OBSERVABILITY_HOME: Schema.String.pipe(Schema.optionalKey),
});
const environment = Schema.decodeUnknownSync(Environment)(process.env);
const cliManifest: unknown = JSON.parse(
  await readFile(new URL("../cli/package.json", import.meta.url), "utf8"),
);
const cliVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
  cliManifest,
).version;
const browserFields = Object.fromEntries(
  Array.from({ length: 15 }, (_, index): [string, Contract.AttributeDefinition] => [
    `field.f${index}`,
    { classification: "public", required: false, metricLabel: false },
  ]),
);
const contract = Effect.runSync(
  Contract.defineTelemetryContract(
    Contract.telemetryContractDefinition({
      version: 1,
      events: {
        NearLimit: {
          name: "near.limit",
          kind: "domain",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: browserFields,
        },
        AfterLarge: {
          name: "after.large",
          kind: "domain",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {},
        },
        AcceptedEvent: {
          name: "accepted.event",
          kind: "domain",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "proof.id": { classification: "public", required: true, metricLabel: false },
          },
        },
      },
      metrics: {
        BrowserOperations: {
          name: "browser.operations",
          description: "Accepted browser operations",
          unit: "1",
          kind: "counter",
          attributes: {
            "proof.id": { classification: "public", maximumCardinality: 1 },
          },
        },
      },
      auditActions: {},
    }),
  ),
);
const config = await Effect.runPromise(
  parseNodeObservabilityConfig({
    enabled: true,
    profile: "nestjs-api",
    service: { name: "browser-signal-canary", version: "0.3.0", environment: "test" },
    telemetry: { endpoint: new URL("http://127.0.0.1:4318") },
    evlog: { contract, policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] } },
    sentry: { enabled: false },
  }),
);
const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1, transportRetries: 0 });
const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
if (!observability.enabled) {
  throw new BrowserSignalCanaryError({
    code: "OBS_BROWSER_SIGNAL_CANARY_INVALID",
    message: "The browser signal canary requires enabled observability.",
  });
}
const exportPath = join(
  environment.OBSERVABILITY_HOME ?? join(homedir(), ".local", "state", "observability"),
  cliVersion,
  "data",
  "otlp.jsonl",
);

class ProbeController {
  async export(): Promise<{ readonly content: string }> {
    await observability.flush();
    const content = await readFile(exportPath, "utf8").catch(() => "");
    return { content };
  }
}
Controller("_probe")(ProbeController);
const exportDescriptor = Object.getOwnPropertyDescriptor(ProbeController.prototype, "export");
if (exportDescriptor === undefined) {
  throw new BrowserSignalCanaryError({
    code: "OBS_BROWSER_SIGNAL_CANARY_INVALID",
    message: "The browser signal canary export endpoint is unavailable.",
  });
}
Get("export")(ProbeController.prototype, "export", exportDescriptor);

class CanaryModule {}
Module({
  controllers: [
    createBrowserEventsController(observability.runtime, { eventLayer: observability.eventLayer }),
    ProbeController,
  ],
})(CanaryModule);
const app = await NestFactory.create(CanaryModule, { logger: false });
await app.listen(0, "127.0.0.1");
const port = Schema.decodeUnknownSync(Address)(app.getHttpServer().address()).port;
const teardown: Plugin = {
  name: "browser-signal-canary-teardown",
  closeBundle: async () => {
    await app.close();
    await observability.close();
  },
};

export default defineConfig({
  plugins: [teardown],
  server: {
    proxy: {
      "/_telemetry": { target: `http://127.0.0.1:${port}` },
      "/_probe": { target: `http://127.0.0.1:${port}` },
    },
  },
  test: {
    include: ["packages/nestjs/test/signalsCanary.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
