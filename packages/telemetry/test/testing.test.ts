import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Metric, Option } from "effect";
import { parseResourceIdentity } from "../src/ResourceIdentity.ts";
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
      const histogram = Metric.histogram("testing.duration", {
        description: "Testing duration",
        attributes: { "testing.run_id": runId, unit: "ms" },
        boundaries: [10, 20],
      });
      const gauge = Metric.gauge("testing.load", {
        description: "Testing load",
        attributes: { "testing.run_id": runId, unit: "%" },
      });
      const identity = yield* parseResourceIdentity({
        serviceName: "testing-service",
        serviceVersion: "9.9.9",
        environment: "test",
        instance: Option.some("testing-instance"),
      });
      const { exit, telemetry } = yield* Testing.run(
        Effect.gen(function* () {
          yield* Effect.sleep("5 millis").pipe(Effect.withSpan("testing.child"));
          yield* WideEvent.emit("testing.completed", { "testing.run_id": runId });
          yield* Metric.update(counter, 1);
          yield* Metric.update(histogram, 12);
          yield* Metric.update(gauge, 7);
          return "done";
        }).pipe(Effect.withSpan("testing.operation")),
        {
          config: new TelemetryConfig({
            identity,
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
        attributeOrUndefined(root.resourceAttributes, "service.namespace"),
        "equipe-tech",
      );
      assert.strictEqual(
        attributeOrUndefined(root.resourceAttributes, "service.name"),
        "testing-service",
      );
      assert.strictEqual(attributeOrUndefined(root.resourceAttributes, "service.version"), "9.9.9");
      assert.strictEqual(
        attributeOrUndefined(root.resourceAttributes, "deployment.environment.name"),
        "test",
      );
      assert.strictEqual(
        attributeOrUndefined(root.resourceAttributes, "service.instance.id"),
        "testing-instance",
      );

      const log = telemetry.logs.find(
        (candidate) =>
          attributeOrUndefined(candidate.attributes, "event.name") === "testing.completed",
      );
      assert.isDefined(log);
      assert.deepStrictEqual(log.traceId, Option.some(root.traceId));
      assert.strictEqual(attributeOrUndefined(log.attributes, "event.kind"), "wide");
      assert.strictEqual(attributeOrUndefined(log.attributes, "testing.run_id"), runId);
      assert.strictEqual(
        attributeOrUndefined(log.resourceAttributes, "service.instance.id"),
        "testing-instance",
      );

      const metric = telemetry.metrics.find((candidate) => candidate.name === "testing.operations");
      assert.isDefined(metric);
      const point = metric.points.find(
        (candidate) => attributeOrUndefined(candidate.attributes, "testing.run_id") === runId,
      );
      assert.isDefined(point);
      assert.deepStrictEqual(point.value, Option.some(1));
      assert.strictEqual(
        attributeOrUndefined(metric.resourceAttributes, "service.namespace"),
        "equipe-tech",
      );
      assert.isUndefined(attributeOrUndefined(metric.resourceAttributes, "service.instance.id"));
      for (const capturedMetric of telemetry.metrics) {
        assert.isUndefined(
          attributeOrUndefined(capturedMetric.resourceAttributes, "service.instance.id"),
        );
        for (const capturedPoint of capturedMetric.points) {
          assert.isUndefined(attributeOrUndefined(capturedPoint.attributes, "service.instance.id"));
        }
      }
      assert.strictEqual(metric.kind, "sum");
      if (metric.kind === "sum") {
        assert.isFalse(metric.isMonotonic);
        assert.strictEqual(metric.aggregationTemporality, 2);
      }

      const capturedHistogram = telemetry.metrics.find(
        (candidate) => candidate.name === "testing.duration",
      );
      assert.isDefined(capturedHistogram);
      assert.strictEqual(capturedHistogram.kind, "histogram");
      assert.strictEqual(capturedHistogram.unit, "ms");
      if (capturedHistogram.kind === "histogram") {
        const histogramPoint = capturedHistogram.histogramPoints[0];
        assert.isDefined(histogramPoint);
        assert.strictEqual(histogramPoint.count, 1);
        assert.strictEqual(histogramPoint.sum, 12);
        assert.deepStrictEqual(histogramPoint.explicitBounds, [10]);
        assert.deepStrictEqual(histogramPoint.bucketCounts, [0, 1]);
        assert.strictEqual(
          histogramPoint.bucketCounts.length,
          histogramPoint.explicitBounds.length + 1,
        );
        assert.isTrue(Option.isNone(Testing.attribute(histogramPoint.attributes, "unit")));
      }

      const capturedGauge = telemetry.metrics.find(
        (candidate) => candidate.name === "testing.load",
      );
      assert.isDefined(capturedGauge);
      assert.strictEqual(capturedGauge.kind, "gauge");
      assert.strictEqual(capturedGauge.unit, "%");
      const capturedGaugePoint = capturedGauge.points[0];
      assert.isDefined(capturedGaugePoint);
      assert.deepStrictEqual(capturedGaugePoint.value, Option.some(7));
      assert.isTrue(Option.isNone(Testing.attribute(capturedGaugePoint.attributes, "unit")));
    }),
  );

  it.live("rejects duplicate resource attributes through the capture options", () =>
    Effect.gen(function* () {
      const result = yield* Testing.run(Effect.void, {
        resourceAttributes: [{ key: "service.name", value: "duplicate" }],
      });
      assert.isTrue(Exit.isFailure(result.exit));
      if (Exit.isFailure(result.exit)) {
        assert.isTrue(Cause.hasDies(result.exit.cause));
        assert.include(
          JSON.stringify(result.exit.cause),
          "OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE",
        );
      }
    }),
  );

  it.live("rejects non-scalar resource values through the capture options", () =>
    Effect.gen(function* () {
      const resourceAttributes = JSON.parse(
        '[{"key":"deployment.region","value":{"nested":true}}]',
      );
      const result = yield* Testing.run(Effect.void, { resourceAttributes });
      assert.isTrue(Exit.isFailure(result.exit));
      if (Exit.isFailure(result.exit)) {
        assert.isTrue(Cause.hasDies(result.exit.cause));
        assert.include(
          JSON.stringify(result.exit.cause),
          "OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE",
        );
      }
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
