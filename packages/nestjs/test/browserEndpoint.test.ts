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
        BrowserFailed: {
          name: "browser.render.crash",
          kind: "defect",
          defaultSeverity: "error",
          mandatory: false,
          sampling: { kind: "always" },
          attributes: {
            "error.origin": { classification: "internal", required: false, metricLabel: false },
          },
        },
      },
      metrics: {
        BrowserRenderCount: {
          name: "react.render_count",
          description: "Completed browser renders",
          unit: "1",
          kind: "counter",
          attributes: {
            "run.id": {
              classification: "public",
              maximumCardinality: 1,
            },
          },
        },
      },
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
  const capture = await Effect.runPromise(Testing.makeCapture({ contract: browserContract }));
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
            error: {
              type: `Bearer ${secret}`,
              message: `authorization: Bearer ${secret}`,
              retryable: false,
            },
          },
          { id: "evt-2", name: "page.viewed", occurredAt: 1700000000500, fields: {} },
        ],
      }),
    );

    assert.strictEqual(response.status, 202);
    assert.deepStrictEqual(await response.json(), { accepted: 2, redacted: 3, dropped: 0 });

    const telemetry = await harness.close();
    const boundary = telemetry.spans.find((span) => span.name.includes("/_telemetry/events"));
    assert.isUndefined(boundary);

    const checkout = telemetry.logs.find(
      (log) => attributeOrUndefined(log.attributes, "event.name") === "checkout.completed",
    );
    assert.isDefined(checkout);
    assert.strictEqual(attributeOrUndefined(checkout.attributes, "event.source"), "browser");
    assert.strictEqual(attributeOrUndefined(checkout.attributes, "event.outcome"), "failure");
    assert.notInclude(JSON.stringify(telemetry), secret);
  }, 30_000);

  it("exports browser traces, correlated logs, and selected metrics through the real route", async () => {
    const harness = await startApp(false);
    const client = createBrowserTelemetryClient({
      endpoint: `${harness.baseUrl}/_telemetry/events`,
      metrics: true,
      resource: {
        serviceName: "browser-consumer",
        serviceVersion: "1.2.3",
        environment: "test",
      },
      flushIntervalMs: 60_000,
    });
    const root = client.traces.startSpan("page.load", { "run.id": "browser-route-e2e" });
    const child = client.traces.startSpan(
      "react.render",
      { "run.id": "browser-route-e2e" },
      root.context,
    );
    client.emit("page.rendered", { "run.id": "browser-route-e2e" }, child.context);
    client.metrics.counter("react.render_count").add(1, { "run.id": "browser-route-e2e" });
    child.end();
    root.end();
    await client.flush();
    await client.dispose();
    const telemetry = await harness.close();
    const rootSpan = telemetry.spans.find((span) => span.spanId === root.context.spanId);
    const childSpan = telemetry.spans.find((span) => span.spanId === child.context.spanId);
    const log = telemetry.logs.find(
      (entry) => attributeOrUndefined(entry.attributes, "event.name") === "page.rendered",
    );
    const metric = telemetry.metrics.find((entry) => entry.name === "react.render_count");
    assert.isDefined(rootSpan);
    assert.isDefined(childSpan);
    assert.deepStrictEqual(childSpan.parentSpanId, Option.some(root.context.spanId));
    assert.deepStrictEqual(log?.traceId, Option.some(root.context.traceId));
    assert.deepStrictEqual(log?.spanId, Option.some(child.context.spanId));
    assert.strictEqual(Option.getOrUndefined(metric?.points[0]?.value ?? Option.none()), 1);
    assert.strictEqual(
      attributeOrUndefined(rootSpan.resourceAttributes, "service.name"),
      "browser-consumer",
    );
  }, 30_000);

  it("rejects unowned browser metrics before destination side effects", async () => {
    const harness = await startApp(false);
    const marker = "independentcredentialmarker";
    const requests = [
      {
        version: 1,
        events: [],
        metrics: [{ name: `Bearer ${marker}`, value: 1, occurredAt: 1, fields: {} }],
      },
      {
        version: 1,
        events: [],
        metrics: [
          {
            name: "react.render_count",
            value: 1,
            occurredAt: 1,
            fields: { "customer.id": "unbounded-customer" },
          },
        ],
      },
      {
        version: 1,
        events: [],
        metrics: [
          {
            name: "react.render_count",
            value: 1,
            occurredAt: 1,
            fields: { "run.id": "x".repeat(65) },
          },
        ],
      },
      {
        version: 1,
        events: [],
        metrics: [{ name: "react.render_count", value: -7, occurredAt: 1, fields: {} }],
      },
    ];
    for (const request of requests) {
      const response = await postEvents(harness.baseUrl, JSON.stringify(request));
      assert.strictEqual(response.status, 400);
      const rejection = await Effect.runPromise(decodeRejection(await response.json()));
      assert.strictEqual(rejection.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
    }

    const accepted = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [],
        metrics: [
          {
            name: "react.render_count",
            value: 2,
            occurredAt: 2,
            fields: { "run.id": "browser-metric-owner" },
          },
        ],
      }),
    );
    assert.strictEqual(accepted.status, 202);
    const cardinalityRejected = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [],
        metrics: [
          {
            name: "react.render_count",
            value: 3,
            occurredAt: 3,
            fields: { "run.id": "second-browser-series" },
          },
        ],
      }),
    );
    assert.strictEqual(cardinalityRejected.status, 400);

    const telemetry = await harness.close();
    assert.deepStrictEqual(
      telemetry.metrics.map((metric) => metric.name),
      ["react.render_count"],
    );
    assert.strictEqual(
      Option.getOrUndefined(telemetry.metrics[0]?.points[0]?.value ?? Option.none()),
      2,
    );
    assert.notInclude(JSON.stringify(telemetry), marker);
    assert.strictEqual(telemetry.metrics[0]?.description, "Completed browser renders");
  }, 30_000);

  it("rejects complete signal batches before committing metrics or cardinality", async () => {
    const harness = await startApp(false);
    const metric = (value: number, runId: string) => ({
      name: "react.render_count",
      value,
      occurredAt: 1,
      fields: { "run.id": runId },
    });
    const event = (name: string) => ({ id: crypto.randomUUID(), name, occurredAt: 1, fields: {} });

    const invalidEventAndMetric = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [event("undeclared.event")],
        metrics: [{ ...metric(1, "unused"), name: "undeclared.metric" }],
      }),
    );
    assert.strictEqual(invalidEventAndMetric.status, 400);
    assert.strictEqual(
      (await Effect.runPromise(decodeRejection(await invalidEventAndMetric.json()))).code,
      "OBS_EVENT_UNKNOWN_NAME",
    );

    const invalidEvent = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [event("undeclared.event")],
        metrics: [metric(13, "rejected-event")],
      }),
    );
    assert.strictEqual(invalidEvent.status, 400);
    assert.strictEqual(
      (await Effect.runPromise(decodeRejection(await invalidEvent.json()))).code,
      "OBS_EVENT_UNKNOWN_NAME",
    );

    const invalidLaterMetric = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [],
        metrics: [
          metric(17, "rejected-metric"),
          { ...metric(1, "unused"), name: "undeclared.metric" },
        ],
      }),
    );
    assert.strictEqual(invalidLaterMetric.status, 400);

    const overCardinality = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [],
        metrics: [metric(19, "first-value"), metric(23, "second-value")],
      }),
    );
    assert.strictEqual(overCardinality.status, 400);

    const accepted = await postEvents(
      harness.baseUrl,
      JSON.stringify({ version: 1, events: [], metrics: [metric(2, "second-value")] }),
    );
    assert.strictEqual(accepted.status, 202);

    const telemetry = await harness.close();
    const points = telemetry.metrics.flatMap((captured) => captured.points);
    assert.lengthOf(points, 1);
    assert.strictEqual(Option.getOrUndefined(points[0]?.value ?? Option.none()), 2);
  }, 30_000);

  it("accepts old and new envelopes and preserves defect failure fields", async () => {
    const harness = await startApp(false);
    const response = await postEvents(
      harness.baseUrl,
      JSON.stringify({
        version: 1,
        events: [
          { id: "old", name: "old.event", occurredAt: 1, fields: {} },
          {
            id: "new",
            name: "new.defect",
            occurredAt: 2,
            fields: { "error.origin": "react.uncaught" },
            error: { type: "TypeError", message: "render failed", retryable: false },
          },
        ],
      }),
    );
    assert.strictEqual(response.status, 202);
    assert.deepStrictEqual(await response.json(), { accepted: 2, redacted: 0, dropped: 0 });
    const telemetry = await harness.close();
    const defect = telemetry.logs.find(
      (log) => attributeOrUndefined(log.attributes, "event.name") === "new.defect",
    );
    assert.isDefined(defect);
    assert.strictEqual(attributeOrUndefined(defect.attributes, "event.outcome"), "failure");
    assert.strictEqual(attributeOrUndefined(defect.attributes, "error.type"), "TypeError");
    assert.strictEqual(attributeOrUndefined(defect.attributes, "error.message"), "render failed");
    assert.strictEqual(attributeOrUndefined(defect.attributes, "error.retryable"), false);
  });

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
      JSON.stringify({
        version: 1,
        events: [{ id: "evt", name: "browser.render.crash", occurredAt: 1, fields: {} }],
      }),
      JSON.stringify({
        version: 1,
        events: [
          {
            id: "evt",
            name: "checkout.completed",
            occurredAt: 1,
            fields: { "cart.total": 1 },
            error: { type: "TypeError", message: "invalid", retryable: false },
          },
        ],
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
