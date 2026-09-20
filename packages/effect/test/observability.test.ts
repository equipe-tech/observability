import { assert, describe, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  CurrentCorrelation,
  defineTelemetryContract,
  makeEventProducer,
  parseNodeObservabilityConfig,
  TelemetryEventSink,
} from "@equipe-tech/observability";
import { effectEventsAdapter } from "@equipe-tech/observability/effect";
import { NodeObservabilityService } from "@equipe-tech/observability/node";
import * as Testing from "@equipe-tech/observability/testing";
import {
  httpTelemetry,
  layerBrowserEventsRoute,
  layerObservabilityFromConfig,
  layerObservability,
} from "../src/index.ts";

const contract = await Effect.runPromise(
  defineTelemetryContract({
    version: 1,
    events: {
      ItemRead: {
        name: "item.read",
        kind: "operation",
        defaultSeverity: "info",
        mandatory: true,
        sampling: { kind: "always" },
        attributes: {
          "item.id": { classification: "public", required: true, metricLabel: false },
        },
      },
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
);
const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };
const producer = makeEventProducer(contract);

const Receipt = Schema.Struct({ accepted: Schema.Number });
const decodeReceipt = Schema.decodeUnknownSync(Receipt);
const Rejection = Schema.Struct({ code: Schema.String, correlationId: Schema.String });
const decodeRejection = Schema.decodeUnknownSync(Rejection);

const routes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/items/:id",
    Effect.gen(function* () {
      const correlation = yield* CurrentCorrelation;
      yield* producer.emit("ItemRead", {
        outcome: "success",
        durationMs: 1,
        correlation,
        attributes: { "item.id": "42" },
      });
      return HttpServerResponse.text("ok");
    }),
  ),
  layerBrowserEventsRoute(),
).pipe(Layer.provide(httpTelemetry().layer));

const config = (endpoint: URL, enabled = true) =>
  parseNodeObservabilityConfig({
    enabled,
    profile: "effect-api",
    service: { name: "effect-api-e2e", version: "1.2.3", environment: "test" },
    telemetry: { endpoint },
    evlog: { contract, policy },
    sentry: { enabled: false },
  });

describe("layerObservability", () => {
  it.live("bridges the profile runtime into an Effect HTTP application", () =>
    Effect.gen(function* () {
      const collector = yield* Effect.promise(() => Testing.startOtlpCaptureServer());
      const observability = layerObservabilityFromConfig(yield* config(collector.endpoint), [
        effectEventsAdapter().registration,
      ]);
      const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(observability),
      );
      const outcome = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const handle = yield* NodeObservabilityService;
        const item = yield* client.get("/items/42");
        const accepted = yield* client
          .execute(
            HttpClientRequest.post("/_telemetry/events").pipe(
              HttpClientRequest.bodyJsonUnsafe({
                version: 1,
                events: [
                  {
                    id: "evt-1",
                    name: "checkout.completed",
                    occurredAt: 1_700_000_000_000,
                    fields: { "cart.total": 42 },
                  },
                ],
              }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              Effect.map(response.json, (body) => [response.status, body] as const),
            ),
          );
        const rejected = yield* client
          .execute(
            HttpClientRequest.post("/_telemetry/events").pipe(
              HttpClientRequest.bodyJsonUnsafe({ version: "x" }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              Effect.map(response.json, (body) => [response.status, body] as const),
            ),
          );
        const flush = yield* Effect.promise(() => handle.flush());
        return { enabled: handle.enabled, item: item.status, accepted, rejected, flush };
      }).pipe(Effect.provide(server), Effect.scoped);
      const telemetry = collector.telemetry();
      yield* Effect.promise(() => collector.stop());

      assert.isTrue(outcome.enabled);
      assert.equal(outcome.item, 200);
      assert.equal(outcome.accepted[0], 202);
      assert.equal(decodeReceipt(outcome.accepted[1]).accepted, 1);
      assert.equal(outcome.rejected[0], 400);
      assert.equal(decodeRejection(outcome.rejected[1]).code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
      assert.equal(outcome.flush.operation, "flush");
      assert.isFalse(outcome.flush.degraded);

      const serverSpan = telemetry.spans.find((span) => span.name === "GET /items/:id");
      assert.isDefined(serverSpan);
      assert.equal(
        Option.getOrUndefined(Testing.attribute(serverSpan.resourceAttributes, "service.name")),
        "effect-api-e2e",
      );
      assert.isFalse(telemetry.spans.some((span) => span.name.startsWith("http.server")));
      const itemEvent = telemetry.logs.find((log) => Option.contains(log.body, "item.read"));
      assert.isDefined(itemEvent);
      assert.deepEqual(itemEvent.traceId, Option.some(serverSpan.traceId));
      assert.equal(Option.getOrUndefined(Testing.attribute(itemEvent.attributes, "item.id")), "42");
      const browserEvent = telemetry.logs.find((log) =>
        Option.contains(log.body, "checkout.completed"),
      );
      assert.isDefined(browserEvent);
      assert.equal(
        Option.getOrUndefined(Testing.attribute(browserEvent.attributes, "event.source")),
        "browser",
      );
    }),
  );

  it.live("keeps the application silent when observability is disabled", () =>
    Effect.gen(function* () {
      const collector = yield* Effect.promise(() => Testing.startOtlpCaptureServer());
      const observability = layerObservabilityFromConfig(yield* config(collector.endpoint, false), [
        effectEventsAdapter().registration,
      ]);
      const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(observability),
      );
      const outcome = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const handle = yield* NodeObservabilityService;
        const sink = yield* TelemetryEventSink;
        const item = yield* client.get("/items/42");
        return { enabled: handle.enabled, item: item.status, sink: sink !== undefined };
      }).pipe(Effect.provide(server), Effect.scoped);
      const telemetry = collector.telemetry();
      yield* Effect.promise(() => collector.stop());
      assert.isFalse(outcome.enabled);
      assert.equal(outcome.item, 200);
      assert.isTrue(outcome.sink);
      assert.equal(telemetry.spans.length, 0);
      assert.equal(telemetry.logs.length, 0);
    }),
  );

  it.live("fails the layer with the configuration error from the environment", () =>
    Effect.gen(function* () {
      const error = yield* Effect.scoped(
        Layer.build(
          layerObservability({
            enabled: true,
            profile: "effect-api",
            env: { OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" },
            contract,
            policy,
            adapters: [effectEventsAdapter().registration],
          }),
        ),
      ).pipe(Effect.flip);
      assert.equal(error._tag, "InvalidObservabilityConfig");
    }),
  );
});
