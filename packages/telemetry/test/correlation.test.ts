import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import {
  CorrelationContext,
  generateRunId,
  parseRequestId,
  parseSpanId,
  parseTraceId,
  withBackgroundCorrelation,
  withCorrelation,
} from "../src/Correlation.ts";
import {
  defineTelemetryContract,
  makeEventProducer,
  telemetryContractDefinition,
} from "../src/contract/index.ts";
import { layerWideEvent } from "../src/effect/WideEventSink.ts";
import * as Testing from "../src/testing/index.ts";

const attributeOrUndefined = (
  attributes: Testing.CapturedAttributes,
  key: string,
): Testing.CapturedAttributeValue | undefined =>
  Option.getOrUndefined(Testing.attribute(attributes, key));

const correlationContract = telemetryContractDefinition({
  version: 1,
  events: {
    Completed: {
      name: "job.completed",
      kind: "domain",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {},
  auditActions: {},
});

describe("CorrelationContext", () => {
  for (const traceId of ["a".repeat(32), "0123456789abcdef0123456789abcdef"]) {
    it.effect(`accepts trace id ${traceId}`, () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* parseTraceId(traceId), traceId);
      }),
    );
  }

  for (const traceId of ["A".repeat(32), "a".repeat(31), "a".repeat(33), "0".repeat(32)]) {
    it.effect(`rejects trace id ${traceId}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parseTraceId(traceId));
        assert.strictEqual(error.code, "OBS_CORRELATION_INVALID");
        assert.strictEqual(error.field, "traceId");
        assert.isFalse("value" in error);
      }),
    );
  }

  for (const spanId of ["A".repeat(16), "a".repeat(15), "a".repeat(17), "0".repeat(16)]) {
    it.effect(`rejects span id ${spanId}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parseSpanId(spanId));
        assert.strictEqual(error.field, "spanId");
      }),
    );
  }

  for (const requestId of ["", "a".repeat(129), "request\nsecret"]) {
    it.effect(`rejects bounded request id of length ${requestId.length}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parseRequestId(requestId));
        assert.strictEqual(error.field, "requestId");
        assert.isFalse("value" in error);
      }),
    );
  }

  it.effect("creates bounded distinct job and canary run identifiers", () =>
    Effect.gen(function* () {
      const job = yield* generateRunId("job", "Nightly Billing");
      const canary = yield* generateRunId("canary", "a-".repeat(100));
      assert.match(job, /^job-nightly-billing-[0-9]+-[a-z0-9]+$/);
      assert.match(canary, /^test-[a-z0-9-]+-[0-9]+-[a-z0-9]+$/);
      assert.notInclude(canary, "--");
      assert.isAtMost(job.length, 128);
      assert.isAtMost(canary.length, 128);
      assert.notStrictEqual(job, canary);
    }),
  );

  it.live(
    "parents traced background work to external correlation without duplicating native fields",
    () =>
      Effect.gen(function* () {
        const traceId = yield* parseTraceId("11111111111111111111111111111111");
        const spanId = yield* parseSpanId("2222222222222222");
        const runId = yield* generateRunId("job", "billing");
        const contract = yield* defineTelemetryContract(correlationContract);
        const producer = makeEventProducer(contract);
        const backgroundContext = CorrelationContext.make({
          trace: { _tag: "Traced", traceId, spanId },
          runId: Option.some(runId),
        });
        const { exit, telemetry } = yield* Testing.run(
          producer
            .emit("Completed", { outcome: "success", attributes: {} })
            .pipe(
              Effect.provide(layerWideEvent),
              withBackgroundCorrelation(backgroundContext, "job.billing.traced"),
            ),
        );
        assert.isTrue(Exit.isSuccess(exit));
        const backgroundSpan = telemetry.spans.find((span) => span.name === "job.billing.traced");
        assert.isDefined(backgroundSpan);
        assert.strictEqual(backgroundSpan.traceId, traceId);
        assert.deepStrictEqual(backgroundSpan.parentSpanId, Option.some(spanId));
        const backgroundLog = telemetry.logs.find(
          (log) => attributeOrUndefined(log.attributes, "event.name") === "job.completed",
        );
        assert.isDefined(backgroundLog);
        assert.deepStrictEqual(backgroundLog.traceId, Option.some(traceId));
        assert.isTrue(Option.isSome(backgroundLog.spanId));
        assert.isFalse(Option.contains(backgroundLog.spanId, spanId));
        assert.strictEqual(attributeOrUndefined(backgroundLog.attributes, "run.id"), runId);
        assert.isUndefined(attributeOrUndefined(backgroundLog.attributes, "traceId"));
        assert.isUndefined(attributeOrUndefined(backgroundLog.attributes, "spanId"));
      }),
  );

  it.live("isolates background correlation from an ambient request span", () =>
    Effect.gen(function* () {
      const requestId = yield* parseRequestId("request-1");
      const runId = yield* generateRunId("job", "billing");
      const contract = yield* defineTelemetryContract(correlationContract);
      const producer = makeEventProducer(contract);
      const requestContext = CorrelationContext.make({ requestId: Option.some(requestId) });
      const backgroundContext = CorrelationContext.make({ runId: Option.some(runId) });
      const { exit, telemetry } = yield* Testing.run(
        producer
          .emit("Completed", { outcome: "success", attributes: {} })
          .pipe(
            Effect.provide(layerWideEvent),
            withBackgroundCorrelation(backgroundContext, "job.billing"),
            withCorrelation(requestContext),
            Effect.withSpan("request.parent"),
          ),
      );
      assert.isTrue(Exit.isSuccess(exit));
      const requestSpan = telemetry.spans.find((span) => span.name === "request.parent");
      const backgroundSpan = telemetry.spans.find((span) => span.name === "job.billing");
      assert.isDefined(requestSpan);
      assert.isDefined(backgroundSpan);
      assert.notStrictEqual(backgroundSpan.traceId, requestSpan.traceId);
      assert.isTrue(Option.isNone(backgroundSpan.parentSpanId));
      const backgroundLog = telemetry.logs.find(
        (log) => attributeOrUndefined(log.attributes, "event.name") === "job.completed",
      );
      assert.isDefined(backgroundLog);
      assert.deepStrictEqual(backgroundLog.traceId, Option.some(backgroundSpan.traceId));
      assert.strictEqual(attributeOrUndefined(backgroundLog.attributes, "run.id"), runId);
      assert.isUndefined(attributeOrUndefined(backgroundLog.attributes, "request.id"));
      assert.isUndefined(attributeOrUndefined(backgroundLog.attributes, "traceId"));
      assert.isUndefined(attributeOrUndefined(backgroundLog.attributes, "spanId"));
    }),
  );
});
