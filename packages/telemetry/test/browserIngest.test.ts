import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { maxFieldValueLength } from "../src/BrowserEvents.ts";
import { ingestBrowserEvents } from "../src/node/index.ts";
import { layerWideEvent } from "../src/effect/index.ts";
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

  it.effect("rejects a malformed payload with the invalid batch contract", () =>
    Effect.gen(function* () {
      const failure = yield* ingestBrowserEvents({ nonsense: true }).pipe(
        Effect.provide(layerWideEvent),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "InvalidBrowserEventBatch");
      assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_INVALID_BATCH");
    }),
  );

  it.effect("rejects an unsupported contract version", () =>
    Effect.gen(function* () {
      const failure = yield* ingestBrowserEvents({ version: 2, events: [] }).pipe(
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
