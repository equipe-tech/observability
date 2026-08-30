import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Effect, ManagedRuntime, Option, Schema } from "effect";
import { assert, describe, it } from "vite-plus/test";
import { createBrowserEventsController, TelemetryInterceptor } from "../src/nestjs/index.ts";
import * as Testing from "../src/testing/index.ts";

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

const Rejection = Schema.Struct({
  code: Schema.Literal("OBS_BROWSER_EVENTS_INVALID_BATCH"),
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

const startApp = async (withInterceptor: boolean): Promise<Harness> => {
  const capture = await Effect.runPromise(Testing.makeCapture());
  const runtime = ManagedRuntime.make(capture.layer);

  class AppModule {}
  Module({ controllers: [createBrowserEventsController(runtime)] })(AppModule);

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

  it("answers 400 to a malformed JSON body", async () => {
    const harness = await startApp(true);
    const response = await postEvents(harness.baseUrl, "{ not json");
    assert.strictEqual(response.status, 400);
    await harness.close();
  }, 30_000);

  it("answers 413 when the raw body exceeds the transport limit", async () => {
    const harness = await startApp(true);
    const response = await postEvents(
      harness.baseUrl,
      JSON.stringify({ version: 1, junk: "x".repeat(200_000), events: [] }),
    );
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
