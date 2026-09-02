import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { maxFieldValueLength } from "../src/BrowserEvents.ts";
import { ingestBrowserEvents } from "../src/node/index.ts";
import { layerWideEvent } from "../src/effect/index.ts";
import { CurrentDataPolicy, definePolicy, parseDataPolicy } from "../src/policy/DataPolicy.ts";
import { sensitiveFieldReplacement, sensitiveTextReplacement } from "../src/policy/index.ts";
import * as Testing from "../src/testing/index.ts";

const attributeOrUndefined = (
  attributes: Testing.CapturedAttributes,
  key: string,
): Testing.CapturedAttributeValue | undefined =>
  Option.getOrUndefined(Testing.attribute(attributes, key));

describe("ingestBrowserEvents", () => {
  it.live("re-emits parsed browser events as wide events with server-owned attributes", () =>
    Effect.gen(function* () {
      const secret = crypto.randomUUID().replaceAll("-", "");
      const payload: unknown = {
        version: 1,
        events: [
          {
            id: "evt-1",
            name: "checkout.completed",
            occurredAt: 1700000000000,
            fields: {
              "cart.total": 129.9,
              "cart.items": 3,
              "event.kind": "spoofed",
              "browser.spoof": "spoofed",
              "http.authorization": `Bearer ${secret}`,
            },
          },
          {
            id: "evt-2",
            name: "page.viewed",
            occurredAt: 1700000000500,
            fields: { "page.path": "/checkout" },
          },
        ],
      };

      const { exit, telemetry } = yield* Testing.run(
        ingestBrowserEvents(payload).pipe(Effect.provide(layerWideEvent)),
      );

      assert.deepStrictEqual(exit, Exit.succeed({ accepted: 2, redacted: 1, dropped: 2 }));
      assert.notInclude(JSON.stringify(telemetry.logs), secret);
      const checkout = telemetry.logs.find(
        (log) => attributeOrUndefined(log.attributes, "event.name") === "checkout.completed",
      );
      assert.isDefined(checkout);
      assert.strictEqual(attributeOrUndefined(checkout.attributes, "event.kind"), "wide");
      assert.strictEqual(attributeOrUndefined(checkout.attributes, "event.source"), "browser");
      assert.strictEqual(attributeOrUndefined(checkout.attributes, "browser.event.id"), "evt-1");
      assert.strictEqual(
        attributeOrUndefined(checkout.attributes, "browser.event.occurred_at"),
        1700000000000,
      );
      assert.strictEqual(attributeOrUndefined(checkout.attributes, "cart.total"), 129.9);
      assert.strictEqual(attributeOrUndefined(checkout.attributes, "browser.spoof"), undefined);

      const view = telemetry.logs.find(
        (log) => attributeOrUndefined(log.attributes, "event.name") === "page.viewed",
      );
      assert.isDefined(view);
      assert.strictEqual(attributeOrUndefined(view.attributes, "page.path"), "/checkout");
    }),
  );

  it.live("decodes old and new envelopes at the public ingest boundary", () =>
    Effect.gen(function* () {
      const payload = {
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
      };
      const collector = yield* Testing.makeCollectingTelemetryEventSink();
      const receipt = yield* ingestBrowserEvents(payload).pipe(Effect.provide(collector.layer));
      const events = yield* collector.browserEvents;
      assert.deepStrictEqual(receipt, { accepted: 2, redacted: 0, dropped: 0 });
      assert.strictEqual(events[0]?.name, "old.event");
      assert.isUndefined(events[0]?.error);
      assert.strictEqual(events[1]?.name, "new.defect");
      assert.strictEqual(events[1]?.error?.type, "TypeError");
      assert.strictEqual(events[1]?.error?.message, "render failed");
      assert.isFalse(events[1]?.error?.retryable);
    }),
  );

  it.effect("sanitizes typed error members before the public collecting sink", () =>
    Effect.gen(function* () {
      const secret = "secret-token";
      const compiled = yield* parseDataPolicy(
        definePolicy({
          attributes: {
            "error.type": { classification: "sensitive", required: false, metricLabel: false },
            "error.message": { classification: "internal", required: false, metricLabel: false },
          },
          blockedKeys: [],
          blockedValuePatterns: ["secret-[a-z]+"],
        }),
      );
      const collector = yield* Testing.makeCollectingTelemetryEventSink();
      const receipt = yield* ingestBrowserEvents({
        version: 1,
        events: [
          {
            id: "secret",
            name: "browser.error",
            occurredAt: 1,
            fields: {},
            error: {
              type: secret,
              message: `authorization: Bearer ${secret}`,
              retryable: false,
            },
          },
        ],
      }).pipe(
        Effect.provide(collector.layer),
        Effect.provide(Layer.succeed(CurrentDataPolicy, compiled)),
      );
      const events = yield* collector.browserEvents;
      assert.deepStrictEqual(receipt, { accepted: 1, redacted: 2, dropped: 0 });
      assert.strictEqual(events[0]?.error?.type, sensitiveFieldReplacement);
      assert.include(events[0]?.error?.message ?? "", sensitiveTextReplacement);
      assert.notInclude(JSON.stringify(events), secret);
    }),
  );

  it.effect("rejects a malformed payload with the invalid batch contract", () =>
    Effect.gen(function* () {
      const failure = yield* ingestBrowserEvents({ nonsense: true }).pipe(
        Effect.provide(layerWideEvent),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "InvalidBrowserEventBatch");
      assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
      assert.strictEqual(
        failure.message,
        "The browser event batch is invalid. Send a batch with a positive safe integer version, bounded events, and scalar fields.",
      );
    }),
  );

  it.effect("rejects an invalid envelope version", () =>
    Effect.gen(function* () {
      const failure = yield* ingestBrowserEvents({ version: 0, events: [] }).pipe(
        Effect.provide(layerWideEvent),
        Effect.flip,
      );
      assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
    }),
  );

  it.effect("rejects a batch with more events than the contract allows", () =>
    Effect.gen(function* () {
      const events = Array.from({ length: 65 }, (_, index) => ({
        id: `evt-${index}`,
        name: "flood",
        occurredAt: 1,
        fields: {},
      }));
      const failure = yield* ingestBrowserEvents({ version: 1, events }).pipe(
        Effect.provide(layerWideEvent),
        Effect.flip,
      );
      assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
    }),
  );

  it.effect("rejects oversized typed error members", () =>
    Effect.gen(function* () {
      for (const error of [
        { type: "x".repeat(maxFieldValueLength + 1), message: "bounded", retryable: false },
        { type: "TypeError", message: "x".repeat(maxFieldValueLength + 1), retryable: false },
      ]) {
        const failure = yield* ingestBrowserEvents({
          version: 1,
          events: [{ id: "evt-1", name: "big", occurredAt: 1, fields: {}, error }],
        }).pipe(Effect.provide(layerWideEvent), Effect.flip);
        assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
      }
    }),
  );

  it.effect("rejects oversized field values", () =>
    Effect.gen(function* () {
      const failure = yield* ingestBrowserEvents({
        version: 1,
        events: [
          {
            id: "evt-1",
            name: "big",
            occurredAt: 1,
            fields: { "page.blob": "x".repeat(maxFieldValueLength + 1) },
          },
        ],
      }).pipe(Effect.provide(layerWideEvent), Effect.flip);
      assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
    }),
  );
});
