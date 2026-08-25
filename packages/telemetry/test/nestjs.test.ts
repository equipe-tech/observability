import "reflect-metadata";
import {
  Controller,
  Get,
  NotFoundException,
  Module,
  Req,
  type CallHandler,
  type ExecutionContext,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host.js";
import { Effect, ManagedRuntime, Option, Schema } from "effect";
import { Observable } from "rxjs";
import { assert, describe, expect, it } from "vite-plus/test";
import { TelemetryInterceptor, withRequestSpan } from "../src/nestjs/index.ts";
import * as Testing from "../src/testing/index.ts";

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

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

describe("nestjs TelemetryInterceptor", () => {
  it("records boundary spans for success, client errors, defects and effect children", async () => {
    const capture = await Effect.runPromise(Testing.makeCapture());
    const runtime = ManagedRuntime.make(capture.layer);

    class DemoController {
      ping(): { readonly ok: boolean } {
        return { ok: true };
      }
      missing(): never {
        throw new NotFoundException("Recurso demo não foi encontrado.");
      }
      broken(): never {
        throw new Error("kaput");
      }
      effectful(request: WeakKey): Promise<{ readonly ok: boolean }> {
        return runtime.runPromise(
          Effect.succeed({ ok: true }).pipe(
            Effect.withSpan("nest.child"),
            withRequestSpan(request),
          ),
        );
      }
    }
    Controller("demo")(DemoController);
    Get("ping")(
      DemoController.prototype,
      "ping",
      methodDescriptor(DemoController.prototype, "ping"),
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
    Get("effectful")(
      DemoController.prototype,
      "effectful",
      methodDescriptor(DemoController.prototype, "effectful"),
    );
    Req()(DemoController.prototype, "effectful", 0);

    class AppModule {}
    Module({ controllers: [DemoController] })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalInterceptors(new TelemetryInterceptor(runtime));
    await app.listen(0);
    const address = decodeAddressInfo(app.getHttpServer().address());
    assert.isTrue(Option.isSome(address));
    const baseUrl = `http://127.0.0.1:${Option.getOrThrow(address).port}`;

    const ping = await fetch(`${baseUrl}/demo/ping`);
    assert.strictEqual(ping.status, 200);
    assert.deepStrictEqual(await ping.json(), { ok: true });

    const missing = await fetch(`${baseUrl}/demo/missing`);
    assert.strictEqual(missing.status, 404);

    const broken = await fetch(`${baseUrl}/demo/broken`);
    assert.strictEqual(broken.status, 500);

    const effectful = await fetch(`${baseUrl}/demo/effectful`);
    assert.strictEqual(effectful.status, 200);

    await app.close();
    await runtime.dispose();
    const telemetry = await Effect.runPromise(capture.telemetry);

    const pingSpan = telemetry.spans.find((span) => span.name === "GET DemoController.ping");
    assert.isDefined(pingSpan);
    assert.strictEqual(pingSpan.statusCode, 1);
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "http.request.method"), "GET");
    assert.strictEqual(
      attributeOrUndefined(pingSpan.attributes, "nestjs.controller"),
      "DemoController",
    );
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "nestjs.handler"), "ping");
    assert.strictEqual(attributeOrUndefined(pingSpan.attributes, "http.response.status_code"), 200);

    const missingSpan = telemetry.spans.find((span) => span.name === "GET DemoController.missing");
    assert.isDefined(missingSpan);
    assert.strictEqual(missingSpan.statusCode, 1);
    assert.strictEqual(
      attributeOrUndefined(missingSpan.attributes, "http.response.status_code"),
      404,
    );

    const brokenSpan = telemetry.spans.find((span) => span.name === "GET DemoController.broken");
    assert.isDefined(brokenSpan);
    assert.strictEqual(brokenSpan.statusCode, 2);

    const boundarySpan = telemetry.spans.find(
      (span) => span.name === "GET DemoController.effectful",
    );
    const childSpan = telemetry.spans.find((span) => span.name === "nest.child");
    assert.isDefined(boundarySpan);
    assert.isDefined(childSpan);
    assert.strictEqual(childSpan.traceId, boundarySpan.traceId);
    assert.deepStrictEqual(childSpan.parentSpanId, Option.some(boundarySpan.spanId));
  }, 30_000);

  it("ends the span as cancelled when the response observable unsubscribes", async () => {
    const capture = await Effect.runPromise(Testing.makeCapture());
    const runtime = ManagedRuntime.make(capture.layer);
    const interceptor = new TelemetryInterceptor(runtime);

    class FakeController {
      slow(this: void): void {}
    }
    const request = { method: "get" };
    const response = { statusCode: 200 };
    const context: ExecutionContext = new ExecutionContextHost(
      [request, response],
      FakeController,
      FakeController.prototype.slow,
    );
    const next: CallHandler = {
      handle: () => new Observable(() => {}),
    };

    const subscription = interceptor.intercept(context, next).subscribe();
    subscription.unsubscribe();

    await runtime.dispose();
    const telemetry = await Effect.runPromise(capture.telemetry);
    const span = telemetry.spans.find((candidate) => candidate.name === "GET FakeController.slow");
    assert.isDefined(span);
    expect(attributeOrUndefined(span.attributes, "http.request.cancelled")).toBe(true);
  }, 30_000);
});
