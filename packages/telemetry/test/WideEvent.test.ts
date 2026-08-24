import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger, References } from "effect";
import { emit } from "../src/WideEvent.ts";

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
});
