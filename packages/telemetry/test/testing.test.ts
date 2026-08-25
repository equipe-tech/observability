import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Metric, Option } from "effect";
import * as Testing from "../src/testing/index.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import * as WideEvent from "../src/WideEvent.ts";

const attributeOrUndefined = (
  attributes: Testing.CapturedAttributes,
  key: string,
): Testing.CapturedAttributeValue | undefined =>
  Option.getOrUndefined(Testing.attribute(attributes, key));

describe("Testing.run", () => {
  it.live("captures correlated spans, logs and metrics", () =>
    Effect.gen(function* () {
      const runId = `testing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const counter = Metric.counter("testing.operations", {
        attributes: { "testing.run_id": runId },
      });
      const { exit, telemetry } = yield* Testing.run(
        Effect.gen(function* () {
          yield* Effect.sleep("5 millis").pipe(Effect.withSpan("testing.child"));
          yield* WideEvent.emit("testing.completed", { "testing.run_id": runId });
          yield* Metric.update(counter, 1);
          return "done";
        }).pipe(Effect.withSpan("testing.operation")),
        {
          config: new TelemetryConfig({
            serviceName: "testing-service",
            serviceVersion: "9.9.9",
            environment: "test",
            otlpEndpoint: new URL("http://telemetry.invalid"),
          }),
        },
      );

      assert.deepStrictEqual(exit, Exit.succeed("done"));

      const root = telemetry.spans.find((span) => span.name === "testing.operation");
      const child = telemetry.spans.find((span) => span.name === "testing.child");
      assert.isDefined(root);
      assert.isDefined(child);
      assert.strictEqual(child.traceId, root.traceId);
      assert.deepStrictEqual(child.parentSpanId, Option.some(root.spanId));
      assert.strictEqual(
        attributeOrUndefined(root.resourceAttributes, "service.name"),
        "testing-service",
      );
      assert.strictEqual(attributeOrUndefined(root.resourceAttributes, "service.version"), "9.9.9");
      assert.strictEqual(
        attributeOrUndefined(root.resourceAttributes, "deployment.environment.name"),
        "test",
      );

      const log = telemetry.logs.find(
        (candidate) =>
          attributeOrUndefined(candidate.attributes, "event.name") === "testing.completed",
      );
      assert.isDefined(log);
      assert.deepStrictEqual(log.traceId, Option.some(root.traceId));
      assert.strictEqual(attributeOrUndefined(log.attributes, "event.kind"), "wide");
      assert.strictEqual(attributeOrUndefined(log.attributes, "testing.run_id"), runId);

      const metric = telemetry.metrics.find((candidate) => candidate.name === "testing.operations");
      assert.isDefined(metric);
      const point = metric.points.find(
        (candidate) => attributeOrUndefined(candidate.attributes, "testing.run_id") === runId,
      );
      assert.isDefined(point);
      assert.deepStrictEqual(point.value, Option.some(1));
    }),
  );

  it.live("returns the failure exit without losing captured telemetry", () =>
    Effect.gen(function* () {
      const { exit, telemetry } = yield* Testing.run(
        Effect.fail("boom").pipe(Effect.withSpan("testing.failure")),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.strictEqual(Cause.squash(exit.cause), "boom");
      }
      const span = telemetry.spans.find((candidate) => candidate.name === "testing.failure");
      assert.isDefined(span);
      assert.strictEqual(span.statusCode, 2);
    }),
  );
});
