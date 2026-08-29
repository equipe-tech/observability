import "reflect-metadata";
import {
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Context, Effect, Exit, ManagedRuntime, Option, Schema, Tracer } from "effect";
import { OtlpExporter } from "effect/unstable/observability";
import type { AddressInfo } from "node:net";
import { Observable } from "rxjs";
import { assert, describe, it } from "vite-plus/test";
import { inspectHttpServerRequest } from "../src/nestjs/HttpRoutePolicy.ts";
import {
  requestCorrelation,
  TelemetryInterceptor,
  TelemetryRequestTracker,
  withRequestCorrelation,
  withRequestSpan,
} from "../src/nestjs/index.ts";
import * as Testing from "../src/testing/index.ts";

const AddressBoundary = Schema.Struct({ port: Schema.Number });
const decodeAddress = Schema.decodeUnknownOption(AddressBoundary);

const attributeOrUndefined = (
  attributes: Testing.CapturedAttributes,
  key: string,
): Testing.CapturedAttributeValue | undefined =>
  Option.getOrUndefined(Testing.attribute(attributes, key));

const methodDescriptor = <Prototype extends WeakKey>(
  prototype: Prototype,
  method: string,
): PropertyDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (descriptor === undefined) {
    throw new Error(`The method ${method} does not exist on the controller.`);
  }
  return descriptor;
};

const applicationBaseUrl = (address: string | AddressInfo | null): string => {
  const decoded = decodeAddress(address);
  assert.isTrue(Option.isSome(decoded));
  return `http://127.0.0.1:${Option.getOrThrow(decoded).port}`;
};

const findSpan = (telemetry: Testing.CapturedTelemetry, name: string): Testing.CapturedSpan => {
  const span = telemetry.spans.find((candidate) => candidate.name === name);
  assert.isDefined(span);
  return span;
};

describe("nestjs TelemetryInterceptor", () => {
  it("records static, parameter, client error, defect, exclusion, and connection close semantics", async () => {
    const capture = await Effect.runPromise(Testing.makeCapture());
    const runtime = ManagedRuntime.make(capture.layer);
    let startSlowRequest: (() => void) | undefined;
    const slowRequestStarted = new Promise<void>((resolve) => {
      startSlowRequest = resolve;
    });

    class DemoController {
      ping(): { readonly ok: boolean } {
        return { ok: true };
      }
      item(id: string): { readonly id: string } {
        return { id };
      }
      redirect(): { readonly redirected: boolean } {
        return { redirected: true };
      }
      missing(): never {
        throw new NotFoundException("Recurso demo não foi encontrado.");
      }
      broken(): never {
        throw new Error("private defect text");
      }
      unavailable(): never {
        throw new ServiceUnavailableException("private outage text");
      }
      effectful(request: WeakKey): Promise<{ readonly ok: boolean; readonly requestId: string }> {
        const correlation = Option.getOrThrow(requestCorrelation(request));
        return runtime.runPromise(
          Effect.succeed({
            ok: true,
            requestId: Option.getOrThrow(correlation.requestId),
          }).pipe(Effect.withSpan("nest.child"), withRequestCorrelation(request)),
        );
      }
      slow(): Observable<never> {
        return new Observable(() => {
          startSlowRequest?.();
          return () => {};
        });
      }
    }
    Controller("demo")(DemoController);
    Get("ping")(
      DemoController.prototype,
      "ping",
      methodDescriptor(DemoController.prototype, "ping"),
    );
    Get("items/:id")(
      DemoController.prototype,
      "item",
      methodDescriptor(DemoController.prototype, "item"),
    );
    Param("id")(DemoController.prototype, "item", 0);
    Get("redirect")(
      DemoController.prototype,
      "redirect",
      methodDescriptor(DemoController.prototype, "redirect"),
    );
    HttpCode(302)(
      DemoController.prototype,
      "redirect",
      methodDescriptor(DemoController.prototype, "redirect"),
    );
    Get("missing")(
      DemoController.prototype,
      "missing",
      methodDescriptor(DemoController.prototype, "missing"),
    );
    Get("broken")(
      DemoController.prototype,
      "broken",
      methodDescriptor(DemoController.prototype, "broken"),
    );
    Get("unavailable")(
      DemoController.prototype,
      "unavailable",
      methodDescriptor(DemoController.prototype, "unavailable"),
    );
    Get("effectful")(
      DemoController.prototype,
      "effectful",
      methodDescriptor(DemoController.prototype, "effectful"),
    );
    Req()(DemoController.prototype, "effectful", 0);
    Get("slow")(
      DemoController.prototype,
      "slow",
      methodDescriptor(DemoController.prototype, "slow"),
    );

    class InternalController {
      health(): { readonly ok: boolean } {
        return { ok: true };
      }
      telemetry(): { readonly accepted: boolean } {
        return { accepted: true };
      }
      ready(): { readonly ok: boolean } {
        return { ok: true };
      }
      adjacent(): { readonly ok: boolean } {
        return { ok: true };
      }
    }
    Controller()(InternalController);
    Get("health")(
      InternalController.prototype,
      "health",
      methodDescriptor(InternalController.prototype, "health"),
    );
    Get("_telemetry/events")(
      InternalController.prototype,
      "telemetry",
      methodDescriptor(InternalController.prototype, "telemetry"),
    );
    Get("ready")(
      InternalController.prototype,
      "ready",
      methodDescriptor(InternalController.prototype, "ready"),
    );
    Get("healthcheck")(
      InternalController.prototype,
      "adjacent",
      methodDescriptor(InternalController.prototype, "adjacent"),
    );

    class AppModule {}
    Module({ controllers: [DemoController, InternalController] })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalInterceptors(
      new TelemetryInterceptor(runtime, { healthRouteTemplates: ["/ready/"] }),
    );
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());

    try {
      const ping = await fetch(`${baseUrl}/demo/ping?token=query-secret`, {
        headers: {
          forwarded: "for=203.0.113.8;proto=https;host=spoofed.example",
          "x-forwarded-for": "203.0.113.8",
          "x-forwarded-host": "spoofed.example",
          "x-forwarded-proto": "https",
        },
      });
      assert.strictEqual(ping.status, 200);
      assert.deepStrictEqual(await ping.json(), { ok: true });

      for (const id of ["first-secret-id", "second-secret-id"]) {
        const item = await fetch(`${baseUrl}/demo/items/${id}?password=query-secret`);
        assert.strictEqual(item.status, 200);
        assert.deepStrictEqual(await item.json(), { id });
      }

      const redirect = await fetch(`${baseUrl}/demo/redirect`, { redirect: "manual" });
      assert.strictEqual(redirect.status, 302);

      const missing = await fetch(`${baseUrl}/demo/missing`);
      assert.strictEqual(missing.status, 404);

      const broken = await fetch(`${baseUrl}/demo/broken`);
      assert.strictEqual(broken.status, 500);

      const unavailable = await fetch(`${baseUrl}/demo/unavailable`);
      assert.strictEqual(unavailable.status, 503);

      const effectful = await fetch(`${baseUrl}/demo/effectful`);
      assert.strictEqual(effectful.status, 200);
      const effectfulBody = await effectful.json();
      const EffectfulResponse = Schema.Struct({ ok: Schema.Boolean, requestId: Schema.String });
      const decodedEffectful = Schema.decodeUnknownSync(EffectfulResponse)(effectfulBody);
      assert.isTrue(decodedEffectful.ok);
      assert.isAbove(decodedEffectful.requestId.length, 0);
      assert.isAtMost(decodedEffectful.requestId.length, 128);

      for (const excludedPath of ["/health", "/_telemetry/events", "/ready"]) {
        const excluded = await fetch(`${baseUrl}${excludedPath}`);
        assert.strictEqual(excluded.status, 200);
      }

      const adjacent = await fetch(`${baseUrl}/healthcheck`);
      assert.strictEqual(adjacent.status, 200);

      const unknown = await fetch(`${baseUrl}/not-a-route`);
      assert.strictEqual(unknown.status, 404);

      const abortController = new AbortController();
      const slowResponse = fetch(`${baseUrl}/demo/slow`, { signal: abortController.signal }).catch(
        () => undefined,
      );
      await slowRequestStarted;
      abortController.abort();
      await slowResponse;
      await new Promise((resolve) => setTimeout(resolve, 50));

      const linked = Tracer.externalSpan({
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
      });
      await runtime.runPromise(
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan;
          span.event("parity.event", 1n, { preserved: true });
        }).pipe(
          Effect.withSpan("non-http.parity", {
            kind: "producer",
            attributes: { "parity.attribute": "kept" },
            links: [{ span: linked, attributes: { relationship: "test" } }],
          }),
        ),
      );
      await runtime.runPromise(
        Effect.fail("non-http failure").pipe(Effect.withSpan("non-http.failure"), Effect.exit),
      );
      const tracer = runtime.runSync(Effect.tracer);
      const clock = runtime.runSync(Effect.clockWith(Effect.succeed));
      const cancellationSpan = tracer.span({
        name: "GET /cancelled-fallback",
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: clock.currentTimeNanosUnsafe(),
        kind: "server",
        root: true,
        sampled: true,
      });
      cancellationSpan.attribute("http.request.method", "GET");
      cancellationSpan.attribute("http.route", "/cancelled-fallback");
      cancellationSpan.end(clock.currentTimeNanosUnsafe(), Exit.interrupt());
      const defectSpan = tracer.span({
        name: "POST /defect-without-status",
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: clock.currentTimeNanosUnsafe(),
        kind: "server",
        root: true,
        sampled: true,
      });
      defectSpan.attribute("http.request.method", "POST");
      defectSpan.attribute("http.route", "/defect-without-status");
      defectSpan.attribute("error.type", "TypeError");
      defectSpan.end(clock.currentTimeNanosUnsafe(), Exit.die(new TypeError("private")));
      const informationalSpan = tracer.span({
        name: "GET /informational",
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: clock.currentTimeNanosUnsafe(),
        kind: "server",
        root: true,
        sampled: true,
      });
      informationalSpan.attribute("http.request.method", "GET");
      informationalSpan.attribute("http.route", "/informational");
      informationalSpan.attribute("http.response.status_code", 101);
      informationalSpan.end(clock.currentTimeNanosUnsafe(), Exit.succeed(undefined));
      await runtime.runPromise(Effect.flatMap(OtlpExporter.Flusher, (flusher) => flusher.flush));
    } finally {
      await app.close();
      await runtime.dispose();
    }

    const telemetry = await Effect.runPromise(capture.telemetry);
    const pingSpan = findSpan(telemetry, "GET /demo/ping");
    assert.strictEqual(pingSpan.statusCode, 0);
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "http.request.method"), "GET");
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "http.route"), "/demo/ping");
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "url.path"), "/demo/ping");
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "url.scheme"), "http");
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "http.response.status_code"), 200);
    assert.isDefined(attributeOrUndefined(pingSpan.attributes, "client.address"));
    assert.notStrictEqual(
      attributeOrUndefined(pingSpan.attributes, "client.address"),
      "203.0.113.8",
    );
    assert.strictEqual(
      attributeOrUndefined(pingSpan.attributes, "network.peer.address"),
      attributeOrUndefined(pingSpan.attributes, "client.address"),
    );
    assert.isDefined(attributeOrUndefined(pingSpan.attributes, "network.peer.port"));
    assert.isUndefined(attributeOrUndefined(pingSpan.attributes, "server.address"));
    assert.isUndefined(attributeOrUndefined(pingSpan.attributes, "url.query"));
    assert.isUndefined(attributeOrUndefined(pingSpan.attributes, "url.full"));
    assert.isUndefined(attributeOrUndefined(pingSpan.attributes, "user_agent.original"));

    const itemSpans = telemetry.spans.filter((span) => span.name === "GET /demo/items/:id");
    assert.lengthOf(itemSpans, 2);
    for (const itemSpan of itemSpans) {
      assert.strictEqual(
        attributeOrUndefined(itemSpan.attributes, "url.path"),
        "/demo/items/REDACTED",
      );
      assert.strictEqual(
        attributeOrUndefined(itemSpan.attributes, "http.route"),
        "/demo/items/:id",
      );
    }

    const redirectSpan = findSpan(telemetry, "GET /demo/redirect");
    assert.strictEqual(redirectSpan.statusCode, 0);
    assert.strictEqual(
      attributeOrUndefined(redirectSpan.attributes, "http.response.status_code"),
      302,
    );

    const missingSpan = findSpan(telemetry, "GET /demo/missing");
    assert.strictEqual(missingSpan.statusCode, 0);
    assert.strictEqual(
      attributeOrUndefined(missingSpan.attributes, "http.response.status_code"),
      404,
    );
    assert.isUndefined(attributeOrUndefined(missingSpan.attributes, "error.type"));

    const brokenSpan = findSpan(telemetry, "GET /demo/broken");
    assert.strictEqual(brokenSpan.statusCode, 2);
    assert.strictEqual(
      attributeOrUndefined(brokenSpan.attributes, "http.response.status_code"),
      500,
    );
    assert.strictEqual(attributeOrUndefined(brokenSpan.attributes, "error.type"), "500");
    assert.isTrue(Option.isNone(brokenSpan.statusMessage));
    assert.notInclude(brokenSpan.eventNames, "exception");

    const unavailableSpan = findSpan(telemetry, "GET /demo/unavailable");
    assert.strictEqual(unavailableSpan.statusCode, 2);
    assert.strictEqual(
      attributeOrUndefined(unavailableSpan.attributes, "http.response.status_code"),
      503,
    );
    assert.strictEqual(attributeOrUndefined(unavailableSpan.attributes, "error.type"), "503");

    const boundarySpan = findSpan(telemetry, "GET /demo/effectful");
    const childSpan = findSpan(telemetry, "nest.child");
    assert.strictEqual(childSpan.traceId, boundarySpan.traceId);
    assert.deepStrictEqual(childSpan.parentSpanId, Option.some(boundarySpan.spanId));
    assert.strictEqual(childSpan.statusCode, 1);

    const slowSpan = findSpan(telemetry, "GET /demo/slow");
    assert.strictEqual(slowSpan.statusCode, 2);
    assert.strictEqual(
      attributeOrUndefined(slowSpan.attributes, "error.type"),
      "connection_closed",
    );

    for (const excludedSpanName of [
      "GET /_telemetry/events",
      "GET /health",
      "GET /ready",
      "GET /not-a-route",
    ]) {
      assert.isUndefined(telemetry.spans.find((span) => span.name === excludedSpanName));
    }
    assert.isDefined(telemetry.spans.find((span) => span.name === "GET /healthcheck"));

    const paritySpan = findSpan(telemetry, "non-http.parity");
    assert.strictEqual(paritySpan.statusCode, 1);
    assert.strictEqual(paritySpan.kind, 4);
    assert.deepStrictEqual(paritySpan.eventNames, ["parity.event"]);
    assert.deepStrictEqual(paritySpan.linkedSpanIds, ["2222222222222222"]);
    assert.strictEqual(attributeOrUndefined(paritySpan.attributes, "parity.attribute"), "kept");
    assert.strictEqual(findSpan(telemetry, "non-http.failure").statusCode, 2);
    const cancellationSpan = findSpan(telemetry, "GET /cancelled-fallback");
    assert.strictEqual(cancellationSpan.statusCode, 0);
    assert.isUndefined(attributeOrUndefined(cancellationSpan.attributes, "error.type"));
    const defectSpan = findSpan(telemetry, "POST /defect-without-status");
    assert.strictEqual(defectSpan.statusCode, 2);
    assert.strictEqual(attributeOrUndefined(defectSpan.attributes, "error.type"), "TypeError");
    assert.isTrue(Option.isNone(defectSpan.statusMessage));
    assert.notInclude(defectSpan.eventNames, "exception");
    assert.strictEqual(findSpan(telemetry, "GET /informational").statusCode, 0);
  }, 30_000);

  it("uses framework-resolved proxy values only after explicit opt-in", async () => {
    const capture = await Effect.runPromise(Testing.makeCapture());
    const runtime = ManagedRuntime.make(capture.layer);

    class ProxyController {
      ping(): { readonly ok: boolean } {
        return { ok: true };
      }
    }
    Controller("proxy")(ProxyController);
    Get("ping")(
      ProxyController.prototype,
      "ping",
      methodDescriptor(ProxyController.prototype, "ping"),
    );

    class ProxyModule {}
    Module({ controllers: [ProxyController] })(ProxyModule);

    const adapter = new ExpressAdapter();
    adapter.set("trust proxy", "loopback");
    const app = await NestFactory.create(ProxyModule, adapter, { logger: false });
    app.useGlobalInterceptors(new TelemetryInterceptor(runtime, { proxyPolicy: "framework" }));
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());

    try {
      const response = await fetch(`${baseUrl}/proxy/ping`, {
        headers: {
          "x-forwarded-for": "198.51.100.7",
          "x-forwarded-host": "trusted.example:8443",
          "x-forwarded-proto": "https",
        },
      });
      assert.strictEqual(response.status, 200);
    } finally {
      await app.close();
      await runtime.dispose();
    }

    const span = findSpan(await Effect.runPromise(capture.telemetry), "GET /proxy/ping");
    assert.strictEqual(attributeOrUndefined(span.attributes, "client.address"), "198.51.100.7");
    assert.strictEqual(attributeOrUndefined(span.attributes, "url.scheme"), "https");
    assert.strictEqual(attributeOrUndefined(span.attributes, "server.address"), "trusted.example");
    assert.notStrictEqual(
      attributeOrUndefined(span.attributes, "network.peer.address"),
      "198.51.100.7",
    );
    assert.isUndefined(attributeOrUndefined(span.attributes, "server.port"));
  }, 30_000);

  it("propagates strict W3C traceparent context through real NestJS HTTP requests", async () => {
    const capture = await Effect.runPromise(Testing.makeCapture());
    const runtime = ManagedRuntime.make(capture.layer);

    class TraceparentController {
      sampled(request: WeakKey): Promise<{ readonly route: string }> {
        return runtime.runPromise(
          Effect.succeed({ route: "sampled" }).pipe(
            Effect.withSpan("sampled.child"),
            withRequestSpan(request),
          ),
        );
      }
      unsampled(request: WeakKey): Promise<{ readonly route: string }> {
        return runtime.runPromise(
          Effect.succeed({ route: "unsampled" }).pipe(
            Effect.withSpan("unsampled.child"),
            withRequestSpan(request),
          ),
        );
      }
      absent(): { readonly route: string } {
        return { route: "absent" };
      }
      malformed(): { readonly route: string } {
        return { route: "malformed" };
      }
    }
    Controller("traceparent")(TraceparentController);
    for (const method of ["sampled", "unsampled", "absent", "malformed"]) {
      Get(method)(
        TraceparentController.prototype,
        method,
        methodDescriptor(TraceparentController.prototype, method),
      );
    }
    Req()(TraceparentController.prototype, "sampled", 0);
    Req()(TraceparentController.prototype, "unsampled", 0);

    class TraceparentModule {}
    Module({ controllers: [TraceparentController] })(TraceparentModule);

    const app = await NestFactory.create(TraceparentModule, { logger: false });
    app.useGlobalInterceptors(new TelemetryInterceptor(runtime));
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const parentSpanId = "b7ad6b7169203331";
    const malformedTraceparents = [
      `01-${traceId}-${parentSpanId}-01`,
      `00-${traceId}-${parentSpanId}`,
      `00-${traceId}-${parentSpanId}-01-extra`,
      `00-${traceId}-${parentSpanId}-0`,
      `00-${traceId}-${parentSpanId}-0g`,
      `00-${traceId.toUpperCase()}-${parentSpanId}-01`,
      `00-${traceId}-${parentSpanId.toUpperCase()}-01`,
      `00-${traceId}-${parentSpanId}-A1`,
      `00-${traceId}-${parentSpanId}-01, 00-${traceId}-${parentSpanId}-01`,
      `00-z${traceId.slice(1)}-${parentSpanId}-01`,
      `00-${"0".repeat(32)}-${parentSpanId}-01`,
      `00-${traceId}-${"0".repeat(16)}-01`,
    ];

    try {
      const sampled = await fetch(`${baseUrl}/traceparent/sampled`, {
        headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
      });
      assert.strictEqual(sampled.status, 200);

      const absent = await fetch(`${baseUrl}/traceparent/absent`);
      assert.strictEqual(absent.status, 200);

      for (const traceparent of malformedTraceparents) {
        const malformed = await fetch(`${baseUrl}/traceparent/malformed`, {
          headers: { traceparent },
        });
        assert.strictEqual(malformed.status, 200);
      }

      const unsampled = await fetch(`${baseUrl}/traceparent/unsampled`, {
        headers: { traceparent: `00-${traceId}-${parentSpanId}-00` },
      });
      assert.strictEqual(unsampled.status, 200);
    } finally {
      await app.close();
      await runtime.dispose();
    }

    const telemetry = await Effect.runPromise(capture.telemetry);
    const sampledSpan = findSpan(telemetry, "GET /traceparent/sampled");
    const sampledChild = findSpan(telemetry, "sampled.child");
    assert.strictEqual(sampledSpan.traceId, traceId);
    assert.deepStrictEqual(sampledSpan.parentSpanId, Option.some(parentSpanId));
    assert.strictEqual(sampledChild.traceId, traceId);
    assert.deepStrictEqual(sampledChild.parentSpanId, Option.some(sampledSpan.spanId));

    const absentSpan = findSpan(telemetry, "GET /traceparent/absent");
    assert.isTrue(Option.isNone(absentSpan.parentSpanId));

    const malformedSpans = telemetry.spans.filter(
      (span) => span.name === "GET /traceparent/malformed",
    );
    assert.lengthOf(malformedSpans, malformedTraceparents.length);
    for (const malformedSpan of malformedSpans) {
      assert.isTrue(Option.isNone(malformedSpan.parentSpanId));
    }

    assert.isUndefined(telemetry.spans.find((span) => span.name === "GET /traceparent/unsampled"));
    assert.isUndefined(telemetry.spans.find((span) => span.name === "unsampled.child"));
  }, 30_000);

  it("closes telemetry admission and interrupts every active request once", async () => {
    const tracker = new TelemetryRequestTracker();
    let interruptions = 0;
    let releaseFirst = (): void => {};
    let releaseSecond = (): void => {};
    const first = tracker.register({
      interrupt: () => {
        interruptions++;
        releaseFirst();
      },
    });
    const second = tracker.register({
      interrupt: () => {
        interruptions++;
        releaseSecond();
      },
    });
    assert.isTrue(Option.isSome(first));
    assert.isTrue(Option.isSome(second));
    releaseFirst = Option.getOrThrow(first);
    releaseSecond = Option.getOrThrow(second);
    const idle = tracker.waitForIdle();
    tracker.closeAdmission();
    tracker.interruptActive();
    await idle;
    assert.strictEqual(interruptions, 2);
    assert.isFalse(tracker.accepting);
    assert.isTrue(Option.isNone(tracker.register({ interrupt: () => interruptions++ })));
  });

  it("preserves lowercase known methods when normalization changes the emitted method", () => {
    const lowercaseMethod = inspectHttpServerRequest({
      method: "get",
      route: { path: "/items" },
      originalUrl: "/items",
      socket: {},
    });
    assert.isTrue(Option.isSome(lowercaseMethod));
    assert.strictEqual(Option.getOrThrow(lowercaseMethod).method, "GET");
    assert.deepStrictEqual(Option.getOrThrow(lowercaseMethod).methodOriginal, Option.some("get"));
    assert.strictEqual(Option.getOrThrow(lowercaseMethod).spanName, "GET /items");
  });

  it("bounds unknown methods and omits unsafe paths at the parsed boundary", () => {
    const unknownMethod = inspectHttpServerRequest({
      method: "brew",
      route: { path: "/items/:id" },
      originalUrl: "/items/private-value?token=query-secret",
      socket: { remoteAddress: "127.0.0.1", remotePort: 42_000 },
    });
    assert.isTrue(Option.isSome(unknownMethod));
    assert.strictEqual(Option.getOrThrow(unknownMethod).method, "_OTHER");
    assert.deepStrictEqual(Option.getOrThrow(unknownMethod).methodOriginal, Option.some("brew"));
    assert.strictEqual(Option.getOrThrow(unknownMethod).spanName, "HTTP /items/:id");
    assert.deepStrictEqual(
      Option.getOrThrow(unknownMethod).urlPath,
      Option.some("/items/REDACTED"),
    );

    const complexRoute = inspectHttpServerRequest({
      method: "GET",
      route: { path: "/items/:id(\\d+)" },
      originalUrl: "/items/123",
      socket: {},
    });
    assert.isTrue(Option.isSome(complexRoute));
    assert.isTrue(Option.isNone(Option.getOrThrow(complexRoute).urlPath));

    const absoluteTarget = inspectHttpServerRequest({
      method: "GET",
      route: { path: "/items/:id" },
      originalUrl: "https://user:secret@example.test/items/123",
      socket: {},
    });
    assert.isTrue(Option.isSome(absoluteTarget));
    assert.isTrue(Option.isNone(Option.getOrThrow(absoluteTarget).urlPath));

    const rootRoute = inspectHttpServerRequest({
      method: "GET",
      route: { path: "/" },
      originalUrl: "/?token=query-secret",
      socket: {},
    });
    assert.isTrue(Option.isSome(rootRoute));
    assert.deepStrictEqual(Option.getOrThrow(rootRoute).urlPath, Option.some("/"));

    const unsafeFrameworkHost = inspectHttpServerRequest(
      {
        method: "GET",
        route: { path: "/proxy" },
        originalUrl: "/proxy",
        protocol: "https",
        hostname: "user@spoofed.example",
        ip: "198.51.100.7",
        socket: {},
      },
      { proxyPolicy: "framework" },
    );
    assert.isTrue(Option.isSome(unsafeFrameworkHost));
    assert.isTrue(Option.isNone(Option.getOrThrow(unsafeFrameworkHost).serverAddress));

    const unavailableRoute = inspectHttpServerRequest({
      method: "GET",
      url: "/private",
      socket: {},
    });
    assert.isTrue(Option.isSome(unavailableRoute));
    assert.strictEqual(Option.getOrThrow(unavailableRoute).spanName, "GET");
    assert.isTrue(Option.isNone(Option.getOrThrow(unavailableRoute).route));

    for (const malformedTemplate of [
      "health",
      "https://example.test/health",
      "/health?token=secret",
      "/health#fragment",
      "/health\\private",
      "/health\nprivate",
    ]) {
      assert.throws(() =>
        inspectHttpServerRequest(
          { method: "GET", route: { path: "/safe" }, url: "/safe" },
          { healthRouteTemplates: [malformedTemplate] },
        ),
      );
    }
  });
});
