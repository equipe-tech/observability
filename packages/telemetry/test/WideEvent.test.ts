import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, Option, References } from "effect";
import { emit } from "../src/WideEvent.ts";
import * as Testing from "../src/testing/index.ts";

type CapturedEvent = {
  readonly eventName: unknown;
  readonly eventKind: unknown;
  readonly operationId: unknown;
};

const captureEvent = (fields: {
  readonly [attribute: string]: string | number | boolean;
}): Effect.Effect<ReadonlyArray<CapturedEvent>> => {
  const captured: Array<CapturedEvent> = [];
  const logger = Logger.make<unknown, void>((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    captured.push({
      eventName: annotations["event.name"],
      eventKind: annotations["event.kind"],
      operationId: annotations["operation.id"],
    });
  });
  return emit("checkout.completed", fields).pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.as(captured),
  );
};

describe("WideEvent.emit", () => {
  it.effect("preserves canonical attributes when fields contain reserved keys", () =>
    Effect.gen(function* () {
      const events = yield* captureEvent({
        "event.name": "attacker.name",
        "event.kind": "attacker.kind",
      });
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]?.eventName, "checkout.completed");
      assert.strictEqual(events[0]?.eventKind, "wide");
    }),
  );

  it.effect("preserves unrelated event fields", () =>
    Effect.gen(function* () {
      const events = yield* captureEvent({ "operation.id": "order-123" });
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]?.operationId, "order-123");
    }),
  );

  it.live("records two wide events on their enclosing span without synthetic spans", () =>
    Effect.gen(function* () {
      const result = yield* Testing.run(
        Effect.gen(function* () {
          yield* emit("order.created", { "order.id": "order-123" });
          yield* emit("order.paid", { "order.id": "order-123" });
        }).pipe(Effect.withSpan("http.server.request")),
      );
      assert.deepStrictEqual(
        result.telemetry.spans.map((span) => span.name),
        ["http.server.request"],
      );
      const parent = result.telemetry.spans[0];
      assert.isDefined(parent);
      assert.deepStrictEqual(
        parent.events.map((event) => event.name),
        ["order.created", "order.paid"],
      );
      assert.lengthOf(result.telemetry.logs, 2);
      for (const log of result.telemetry.logs) {
        assert.deepStrictEqual(log.traceId, Option.some(parent.traceId));
        assert.deepStrictEqual(log.spanId, Option.some(parent.spanId));
      }
    }),
  );
});
