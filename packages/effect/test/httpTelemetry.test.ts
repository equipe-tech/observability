import { assert, describe, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";
import { CurrentCorrelation } from "@equipe-tech/observability";
import { WideEvent } from "@equipe-tech/observability/effect";
import * as Testing from "@equipe-tech/observability/testing";
import { request } from "node:http";
import {
  httpTelemetry,
  InvalidTelemetryRoutePolicy,
  layerBuiltInTracerDisabled,
} from "../src/index.ts";

const attributeOrUndefined = (
  attributes: Testing.CapturedAttributes,
  key: string,
): Testing.CapturedAttributeValue | undefined =>
  Option.getOrUndefined(Testing.attribute(attributes, key));

const findSpan = (telemetry: Testing.CapturedTelemetry, name: string): Testing.CapturedSpan => {
  const span = telemetry.spans.find((candidate) => candidate.name === name);
  assert.isDefined(span);
  return span;
};

const ItemBody = Schema.Struct({
  requestId: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
});
const decodeItemBody = Schema.decodeUnknownSync(ItemBody);

const loopback = /^(?:::ffff:)?127\.0\.0\.1$/;

const serverAddress = Effect.map(HttpServer.HttpServer, (server) => {
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}`;
});

const routes = Layer.mergeAll(
  HttpRouter.add("GET", "/ping", HttpServerResponse.jsonUnsafe({ ok: true })),
  HttpRouter.add(
    "GET",
    "/items/:id",
    Effect.gen(function* () {
      const correlation = yield* CurrentCorrelation;
      const parent = yield* Effect.currentParentSpan;
      yield* WideEvent.emit("item.read", { "item.id": "hidden" });
      yield* Effect.log("handler log");
      return HttpServerResponse.jsonUnsafe({
        requestId: Option.getOrUndefined(correlation.requestId),
        traceId: Option.getOrUndefined(correlation.traceId),
        spanId: parent.spanId,
      });
    }),
  ),
  HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
  HttpRouter.add("GET", "/ready", HttpServerResponse.text("ok")),
  HttpRouter.add("GET", "/unavailable", HttpServerResponse.empty({ status: 503 })),
  HttpRouter.add("GET", "/missing", HttpServerResponse.empty({ status: 404 })),
  HttpRouter.add("GET", "/defect", Effect.die(new Error("boom"))),
  HttpRouter.add(
    "GET",
    "/slow",
    Effect.sleep("2 seconds").pipe(Effect.as(HttpServerResponse.text("late"))),
  ),
  HttpRouter.add("GET", "/files/*", HttpServerResponse.text("file")),
);

const server = (options: Parameters<typeof httpTelemetry>[0], capture: Testing.TelemetryCapture) =>
  HttpRouter.serve(routes.pipe(Layer.provide(httpTelemetry(options).layer)), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(capture.layer),
    Layer.provide(layerBuiltInTracerDisabled),
  );

describe("httpTelemetry middleware", () => {
  it.live("records static, parameter, client error, defect, exclusion, and abort semantics", () =>
    Effect.gen(function* () {
      const capture = yield* Testing.makeCapture();
      const body = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const address = yield* serverAddress;
        yield* client.get("/ping");
        const item = yield* client
          .get("/items/42")
          .pipe(Effect.flatMap((response) => response.json));
        yield* client.get("/health");
        yield* client.get("/ready");
        yield* client.get("/unavailable");
        yield* client.get("/missing");
        yield* client.get("/defect");
        yield* client.get("/files/secret/name.txt");
        yield* client.execute(
          HttpClientRequest.get("/ping").pipe(
            HttpClientRequest.setHeader(
              "traceparent",
              "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            ),
          ),
        );
        yield* client.execute(
          HttpClientRequest.get("/ping").pipe(
            HttpClientRequest.setHeader("traceparent", "00-garbage-b7ad6b7169203331-01"),
          ),
        );
        yield* Effect.callback<void>((resume) => {
          const url = new URL(`${address}/slow`);
          const pending = request({ host: url.hostname, port: url.port, path: url.pathname });
          pending.on("error", () => undefined);
          pending.on("close", () => resume(Effect.void));
          pending.end();
          setTimeout(() => pending.destroy(), 100);
        });
        yield* Effect.sleep("100 millis");
        return { item, address };
      }).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provide(server({ healthRouteTemplates: ["/ready"] }, capture)),
        Effect.scoped,
      );
      assert.match(body.address, /^http:\/\/127\.0\.0\.1:\d+$/);
      const telemetry = yield* capture.telemetry;
      const serverSpans = telemetry.spans.filter((span) => span.kind === 2);
      assert.deepEqual(serverSpans.map((span) => span.name).toSorted(), [
        "GET /defect",
        "GET /files/*",
        "GET /items/:id",
        "GET /missing",
        "GET /ping",
        "GET /ping",
        "GET /ping",
        "GET /slow",
        "GET /unavailable",
      ]);
      assert.isFalse(telemetry.spans.some((span) => span.name.startsWith("http.server")));

      const ping = findSpan(telemetry, "GET /ping");
      assert.equal(attributeOrUndefined(ping.attributes, "http.request.method"), "GET");
      assert.equal(attributeOrUndefined(ping.attributes, "http.route"), "/ping");
      assert.equal(attributeOrUndefined(ping.attributes, "url.path"), "/ping");
      assert.equal(attributeOrUndefined(ping.attributes, "url.scheme"), "http");
      assert.equal(attributeOrUndefined(ping.attributes, "http.response.status_code"), 200);
      assert.match(String(attributeOrUndefined(ping.attributes, "client.address")), loopback);
      assert.isUndefined(attributeOrUndefined(ping.attributes, "error.type"));
      assert.isUndefined(attributeOrUndefined(ping.attributes, "url.query"));
      assert.isUndefined(attributeOrUndefined(ping.attributes, "url.full"));
      assert.isFalse(
        [...ping.attributes.keys()].some((key) => key.startsWith("http.request.header")),
      );
      assert.equal(ping.statusCode, 0);

      const item = findSpan(telemetry, "GET /items/:id");
      assert.equal(attributeOrUndefined(item.attributes, "url.path"), "/items/REDACTED");
      const itemBody = decodeItemBody(body.item);
      assert.equal(itemBody.traceId, item.traceId);
      assert.equal(itemBody.spanId, item.spanId);
      assert.match(itemBody.requestId, /^[0-9a-f-]{36}$/);
      const wideEvent = telemetry.logs.find((log) => Option.contains(log.body, "item.read"));
      assert.isDefined(wideEvent);
      assert.deepEqual(wideEvent.traceId, Option.some(item.traceId));
      assert.deepEqual(wideEvent.spanId, Option.some(item.spanId));

      const files = findSpan(telemetry, "GET /files/*");
      assert.equal(attributeOrUndefined(files.attributes, "url.path"), "/files/REDACTED");

      const unavailable = findSpan(telemetry, "GET /unavailable");
      assert.equal(attributeOrUndefined(unavailable.attributes, "http.response.status_code"), 503);
      assert.equal(attributeOrUndefined(unavailable.attributes, "error.type"), "503");
      assert.equal(unavailable.statusCode, 2);

      const missing = findSpan(telemetry, "GET /missing");
      assert.equal(attributeOrUndefined(missing.attributes, "http.response.status_code"), 404);
      assert.isUndefined(attributeOrUndefined(missing.attributes, "error.type"));
      assert.equal(missing.statusCode, 0);

      const defect = findSpan(telemetry, "GET /defect");
      assert.equal(attributeOrUndefined(defect.attributes, "http.response.status_code"), 500);
      assert.equal(attributeOrUndefined(defect.attributes, "error.type"), "500");
      assert.equal(defect.statusCode, 2);

      const slow = findSpan(telemetry, "GET /slow");
      assert.equal(attributeOrUndefined(slow.attributes, "error.type"), "connection_closed");
      assert.isUndefined(attributeOrUndefined(slow.attributes, "http.response.status_code"));

      const pings = telemetry.spans.filter((span) => span.name === "GET /ping");
      const remote = pings.find((span) => span.traceId === "0af7651916cd43dd8448eb211c80319c");
      assert.isDefined(remote);
      assert.deepEqual(remote.parentSpanId, Option.some("b7ad6b7169203331"));
      assert.equal(pings.filter((span) => Option.isNone(span.parentSpanId)).length, 2);
    }),
  );

  it.live("uses forwarded headers only under the framework proxy policy", () =>
    Effect.gen(function* () {
      const direct = yield* Testing.makeCapture();
      const framework = yield* Testing.makeCapture();
      const request = HttpClientRequest.get("/ping").pipe(
        HttpClientRequest.setHeaders({
          "x-forwarded-for": "203.0.113.9, 10.0.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.example.test:8443",
        }),
      );
      yield* HttpClient.execute(request).pipe(Effect.provide(server({}, direct)), Effect.scoped);
      yield* HttpClient.execute(request).pipe(
        Effect.provide(server({ proxyPolicy: "framework" }, framework)),
        Effect.scoped,
      );
      const directSpan = findSpan(yield* direct.telemetry, "GET /ping");
      assert.match(String(attributeOrUndefined(directSpan.attributes, "client.address")), loopback);
      assert.equal(attributeOrUndefined(directSpan.attributes, "url.scheme"), "http");
      assert.isUndefined(attributeOrUndefined(directSpan.attributes, "server.address"));
      const frameworkSpan = findSpan(yield* framework.telemetry, "GET /ping");
      assert.equal(attributeOrUndefined(frameworkSpan.attributes, "client.address"), "203.0.113.9");
      assert.equal(attributeOrUndefined(frameworkSpan.attributes, "url.scheme"), "https");
      assert.equal(
        attributeOrUndefined(frameworkSpan.attributes, "server.address"),
        "api.example.test",
      );
      assert.match(
        String(attributeOrUndefined(frameworkSpan.attributes, "network.peer.address")),
        loopback,
      );
    }),
  );

  it.live("rejects invalid route policy options when the layer builds", () =>
    Effect.gen(function* () {
      const capture = yield* Testing.makeCapture();
      const exit = yield* HttpClient.get("/ping").pipe(
        Effect.provide(server({ healthRouteTemplates: ["relative"] }, capture)),
        Effect.scoped,
        Effect.exit,
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        assert.isTrue(error instanceof InvalidTelemetryRoutePolicy);
        if (error instanceof InvalidTelemetryRoutePolicy) {
          assert.equal(error.code, "OBS_EFFECT_ROUTE_POLICY_INVALID");
          assert.equal(error.field, "healthRouteTemplates");
        }
      }
    }),
  );
});
