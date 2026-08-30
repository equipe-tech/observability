import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer } from "node:http";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { assert, describe, it } from "vite-plus/test";
import {
  browserRequestByteBudget,
  createBrowserTelemetryClient,
  maxEventNameLength,
  maxEventsPerBatch,
  maxBrowserEventOccurredAt,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
} from "@equipe-tech/observability/browser";
import {
  Contract,
  parseNodeObservabilityConfig,
  TelemetryEventSink,
  type BrowserTelemetryEvent,
} from "@equipe-tech/observability";
import { createNodeObservabilityFromConfig } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { layerWideEvent } from "@equipe-tech/observability/effect";
import * as Testing from "@equipe-tech/observability/testing";
import { createBrowserEventsController, TelemetryInterceptor } from "../src/index.ts";

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

const Rejection = Schema.Struct({
  code: Schema.Union([
    Schema.Literal("OBS_BROWSER_EVENTS_INVALID_BATCH"),
    Contract.TelemetryEventErrorCode,
  ]),
  message: Schema.NonEmptyString,
  correlationId: Schema.NonEmptyString,
});
const decodeRejection = Schema.decodeUnknownEffect(Rejection);

const attributeOrUndefined = (
  attributes: Testing.CapturedAttributes,
  key: string,
): Testing.CapturedAttributeValue | undefined =>
  Option.getOrUndefined(Testing.attribute(attributes, key));

type Harness = {
  readonly baseUrl: string;
  readonly close: () => Promise<Testing.CapturedTelemetry>;
};

const browserContract = Effect.runSync(
  Contract.defineTelemetryContract(
    Contract.telemetryContractDefinition({
      version: 1,
      events: {
        CheckoutCompleted: {
          name: "checkout.completed",
          kind: "domain",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "cart.total": { classification: "public", required: true, metricLabel: false },
          },
        },
      },
      metrics: {},
      auditActions: {},
    }),
  ),
);

const contractAdmissionLayer = Layer.succeed(
  TelemetryEventSink,
  TelemetryEventSink.of({
    record: () => Effect.void,
    recordBrowserBatch: (events) =>
      Effect.gen(function* () {
        for (const event of events) {
          const validation = Contract.validateContractEvent(
            browserContract,
            event.name,
            event.attributes,
          );
          if (validation instanceof Contract.InvalidTelemetryEvent) {
            return yield* validation;
          }
        }
      }),
  }),
);

const startApp = async (
  withInterceptor: boolean,
  eventLayer: Layer.Layer<TelemetryEventSink> = layerWideEvent,
): Promise<Harness> => {
  const capture = await Effect.runPromise(Testing.makeCapture());
  const runtime = ManagedRuntime.make(capture.layer);

  class AppModule {}
  Module({
    controllers: [createBrowserEventsController(runtime, { eventLayer })],
  })(AppModule);

  const app = await NestFactory.create(AppModule, { logger: false });
  if (withInterceptor) {
    app.useGlobalInterceptors(new TelemetryInterceptor(runtime));
  }
  await app.listen(0);
  const address = decodeAddressInfo(app.getHttpServer().address());
  assert.isTrue(Option.isSome(address));
  return {
    baseUrl: `http://127.0.0.1:${Option.getOrThrow(address).port}`,
    close: async () => {
      await app.close();
      await runtime.dispose();
      return Effect.runPromise(capture.telemetry);
    },
  };
};

const startRealAdapterApp = async (): Promise<Harness> => {
  const receiver = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const receiverAddress = decodeAddressInfo(receiver.address());
  assert.isTrue(Option.isSome(receiverAddress));
  const contract = browserContract;
  const config = await Effect.runPromise(
    parseNodeObservabilityConfig({
      enabled: true,
      profile: "nestjs-api",
      service: { name: "browser-e2e", version: "1.0.0", environment: "test" },
      telemetry: {
        endpoint: new URL(`http://127.0.0.1:${Option.getOrThrow(receiverAddress).port}`),
      },
      evlog: { contract, policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] } },
      sentry: { enabled: false },
    }),
  );
  const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1, transportRetries: 0 });
  const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
  if (!observability.enabled) throw new Error("Expected enabled observability.");

  class RealAdapterModule {}
  Module({
    controllers: [
      createBrowserEventsController(observability.runtime, {
        eventLayer: observability.eventLayer,
      }),
    ],
  })(RealAdapterModule);
  const app = await NestFactory.create(RealAdapterModule, { logger: false });
  await app.listen(0);
  const address = decodeAddressInfo(app.getHttpServer().address());
  assert.isTrue(Option.isSome(address));
  return {
    baseUrl: `http://127.0.0.1:${Option.getOrThrow(address).port}`,
    close: async () => {
      await app.close();
      await observability.close();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      return { spans: [], logs: [], metrics: [] };
    },
  };
};

const postEvents = (baseUrl: string, body: string): Promise<Response> =>
  fetch(`${baseUrl}/_telemetry/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("browser events endpoint", () => {
  it("accepts a valid batch with 202 while the telemetry route stays excluded", async () => {
    const harness = await startApp(true);
    const secret = crypto.randomUUID().replaceAll("-", "");
    const response = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt-1",
            name: "checkout.completed",
            occurredAt: 1700000000000,
            fields: {
              "cart.total": 42,
              "http.authorization": `Bearer ${secret}`,
            },
          },
          { id: "evt-2", name: "page.viewed", occurredAt: 1700000000500, fields: {} },
        ],
      }),
    );

    assert.strictEqual(response.status, 202);
    assert.deepStrictEqual(await response.json(), { accepted: 2, redacted: 1, dropped: 0 });

    const telemetry = await harness.close();
    const boundary = telemetry.spans.find((span) => span.name.includes("/_telemetry/events"));
    assert.isUndefined(boundary);

    const checkout = telemetry.logs.find(
      (log) => attributeOrUndefined(log.attributes, "event.name") === "checkout.completed",
    );
    assert.isDefined(checkout);
    assert.strictEqual(attributeOrUndefined(checkout.attributes, "event.source"), "browser");
    assert.notInclude(JSON.stringify(telemetry), secret);
  }, 30_000);

  it("accepts a valid request near the documented browser byte budget", async () => {
    const harness = await startApp(true);
    const maximumFields = Object.fromEntries(
      Array.from({ length: maxFieldsPerEvent }, (_, index) => [
        `field.${String(index).padStart(2, "0")}${"k".repeat(maxFieldKeyLength - 8)}`,
        "x".repeat(maxFieldValueLength),
      ]),
    );
    const partialFields = Object.fromEntries(Object.entries(maximumFields).slice(0, 13));
    const body = JSON.stringify({
      version: 1,
      events: [
        { id: "evt-1", name: "maximum.one", occurredAt: 1, fields: maximumFields },
        { id: "evt-2", name: "maximum.two", occurredAt: 1, fields: maximumFields },
        { id: "evt-3", name: "maximum.three", occurredAt: 1, fields: partialFields },
      ],
    });
    const bytes = new TextEncoder().encode(body).byteLength;
    assert.isAbove(bytes, 85_000);
    assert.isAtMost(bytes, browserRequestByteBudget);
    const response = await postEvents(harness.baseUrl, body);
    assert.strictEqual(response.status, 202);
    await harness.close();
  }, 30_000);

  it("delivers maximum multibyte inputs through the default fetch transport", async () => {
    const harness = await startApp(true);
    const fields = Object.fromEntries(
      Array.from({ length: maxFieldsPerEvent }, (_, index) => [
        `${String(index).padStart(2, "0")}${"界".repeat(maxFieldKeyLength - 2)}`,
        "界".repeat(maxFieldValueLength),
      ]),
    );
    const client = createBrowserTelemetryClient({
      endpoint: `${harness.baseUrl}/_telemetry/events`,
      flushIntervalMs: 60_000,
    });
    for (let index = 0; index < maxEventsPerBatch; index += 1) {
      client.emit("n".repeat(maxEventNameLength), fields);
    }
    await client.flush();
    assert.strictEqual(client.pending(), 0);
    await client.dispose();
    await harness.close();
  }, 30_000);

  it("rejects an invalid batch with the public contract and a safe correlation id", async () => {
    const harness = await startApp(true);
    const response = await postEvents(harness.baseUrl, JSON.stringify({ nonsense: true }));

    assert.strictEqual(response.status, 400);
    const payload: unknown = await response.json();
    const rejection = await Effect.runPromise(decodeRejection(payload));
    assert.include(rejection.message, "version 1");
    assert.notInclude(JSON.stringify(payload), "cause");
    assert.notInclude(JSON.stringify(payload), "    at ");

    const telemetry = await harness.close();
    const boundary = telemetry.spans.find((span) => span.name.includes("/_telemetry/events"));
    assert.isUndefined(boundary);
    assert.isTrue(rejection.correlationId.length > 0);
  }, 30_000);

  it("maps contract admission failures to evidence-safe 400 responses", async () => {
    const harness = await startApp(true, contractAdmissionLayer);
    const cases = [
      {
        name: "Invalid Name",
        fields: {},
        code: "OBS_EVENT_UNKNOWN_NAME",
        remediation: "Use a valid declared canonical event name",
      },
      {
        name: "job.error",
        fields: {},
        code: "OBS_EVENT_UNKNOWN_NAME",
        remediation: "Use a valid declared canonical event name",
      },
      {
        name: "job.unknown",
        fields: {},
        code: "OBS_EVENT_UNKNOWN_NAME",
        remediation: "Use a valid declared canonical event name",
      },
      {
        name: "checkout.completed",
        fields: {},
        code: "OBS_EVENT_MISSING_ATTRIBUTE",
        remediation: "Add the declared scalar attribute before emitting",
      },
      {
        name: "checkout.completed",
        fields: { "cart.total": 42, "cart.unknown": "value" },
        code: "OBS_EVENT_UNDECLARED_ATTRIBUTE",
        remediation: "Add it to the contract or remove it from the event",
      },
    ];

    for (const testCase of cases) {
      const response = await postEvents(
        harness.baseUrl,
        JSON.stringify({
          version: 1,
          events: [
            {
              id: "evt-rejected",
              name: testCase.name,
              occurredAt: 1700000000000,
              fields: testCase.fields,
            },
          ],
        }),
      );
      assert.strictEqual(response.status, 400);
      const payload: unknown = await response.json();
      const rejection = await Effect.runPromise(decodeRejection(payload));
      assert.strictEqual(rejection.code, testCase.code);
      assert.include(rejection.message, testCase.remediation);
      assert.notInclude(JSON.stringify(payload), "Schema");
      assert.notInclude(JSON.stringify(payload), "cause");
      assert.notInclude(JSON.stringify(payload), "    at ");
    }
    await harness.close();
  }, 30_000);

  it("admits browser batches atomically and emits valid events once", async () => {
    const offered: Array<BrowserTelemetryEvent> = [];
    const atomicLayer = Layer.succeed(
      TelemetryEventSink,
      TelemetryEventSink.of({
        record: () => Effect.void,
        recordBrowserBatch: (events) =>
          Effect.gen(function* () {
            for (const event of events) {
              const validation = Contract.validateContractEvent(
                browserContract,
                event.name,
                event.attributes,
              );
              if (validation instanceof Contract.InvalidTelemetryEvent) return yield* validation;
            }
            offered.push(...events);
          }),
      }),
    );
    const harness = await startApp(true, atomicLayer);
    const rejected = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "valid-before-invalid",
            name: "checkout.completed",
            occurredAt: 1,
            fields: { "cart.total": 1 },
          },
          {
            id: "invalid",
            name: "checkout.completed",
            occurredAt: 1,
            fields: {},
          },
        ],
      }),
    );
    assert.strictEqual(rejected.status, 400);
    assert.lengthOf(offered, 0);

    const accepted = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "valid-one",
            name: "checkout.completed",
            occurredAt: 1,
            fields: { "cart.total": 1 },
          },
          {
            id: "valid-two",
            name: "checkout.completed",
            occurredAt: 2,
            fields: { "cart.total": 2 },
          },
        ],
      }),
    );
    assert.strictEqual(accepted.status, 202);
    assert.deepStrictEqual(
      offered.map((event) => event.id),
      ["valid-one", "valid-two"],
    );
    await harness.close();
  }, 30_000);

  it("returns evidence-safe 400 responses through the real evlog adapter", async () => {
    const harness = await startRealAdapterApp();
    const cases = [
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: 32_503_680_000_000,
            fields: { "cart.total": 1 },
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: 253_370_764_800_000,
            fields: { "cart.total": 1 },
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: maxBrowserEventOccurredAt + 1,
            fields: { "cart.total": 1 },
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: 8_640_000_000_000_000,
            fields: { "cart.total": 1 },
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: -1,
            fields: { "cart.total": 1 },
          },
        ],
      }),
      '{"version":1,"events":[{"id":"evt","name":"checkout.completed","occurredAt":NaN,"fields":{"cart.total":1}}]}',
      '{"version":1,"events":[{"id":"evt","name":"checkout.completed","occurredAt":Infinity,"fields":{"cart.total":1}}]}',
      JSON.stringify({
        version: 1,
        events: [{ id: "evt", name: "checkout.completed", occurredAt: 1, fields: {} }],
      }),
    ];
    for (const body of cases) {
      const response = await postEvents(harness.baseUrl, body);
      assert.strictEqual(response.status, 400);
      const text = await response.text();
      assert.notInclude(text, "    at ");
      assert.notInclude(text, "RangeError");
      assert.notInclude(text, "Schema");
    }
    const boundary = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: maxBrowserEventOccurredAt,
            fields: { "cart.total": 1 },
          },
        ],
      }),
    );
    assert.strictEqual(boundary.status, 202);
    await harness.close();
  }, 30_000);

  it("answers 400 to a malformed JSON body", async () => {
    const harness = await startApp(true);
    const response = await postEvents(harness.baseUrl, "{ not json");
    assert.strictEqual(response.status, 400);
    await harness.close();
  }, 30_000);

  it("answers 413 above Express's 100 KB transport limit", async () => {
    const harness = await startApp(true);
    const body = JSON.stringify({ version: 1, junk: "x".repeat(102_401), events: [] });
    assert.isAbove(new TextEncoder().encode(body).byteLength, 102_400);
    const response = await postEvents(harness.baseUrl, body);
    assert.strictEqual(response.status, 413);
    await harness.close();
  }, 30_000);

  it("returns a fallback correlation id when the interceptor is not installed", async () => {
    const harness = await startApp(false);
    const response = await postEvents(harness.baseUrl, JSON.stringify({ version: 2, events: [] }));
    assert.strictEqual(response.status, 400);
    const rejection = await Effect.runPromise(decodeRejection(await response.json()));
    assert.isTrue(rejection.correlationId.length > 0);
    await harness.close();
  }, 30_000);
});
