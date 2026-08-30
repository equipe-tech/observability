import { Clock, Context, Effect, Option, Random, Schema, Tracer } from "effect";

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
};

export const TraceId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/),
  Schema.makeFilter((value) => value !== "0".repeat(32), { expected: "a non-zero trace ID" }),
).pipe(Schema.brand("TraceId"));
export type TraceId = typeof TraceId.Type;

export const SpanId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{16}$/),
  Schema.makeFilter((value) => value !== "0".repeat(16), { expected: "a non-zero span ID" }),
).pipe(Schema.brand("SpanId"));
export type SpanId = typeof SpanId.Type;

export const RequestId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => !containsControlCharacter(value), {
    expected: "a value without control characters",
  }),
  Schema.isMaxLength(128),
).pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;

export const RunId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => !containsControlCharacter(value), {
    expected: "a value without control characters",
  }),
  Schema.isMaxLength(128),
).pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const TraceLinkage = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Untraced") }),
  Schema.Struct({ _tag: Schema.Literal("Traced"), traceId: TraceId, spanId: SpanId }),
]);
export type TraceLinkage = typeof TraceLinkage.Type;

export class CorrelationContext extends Schema.Class<CorrelationContext>(
  "@equipe-tech/observability/CorrelationContext",
)({
  trace: TraceLinkage.pipe(Schema.withConstructorDefault(Effect.succeed({ _tag: "Untraced" }))),
  requestId: Schema.Option(RequestId).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  runId: Schema.Option(RunId).pipe(Schema.withConstructorDefault(Effect.succeed(Option.none()))),
}) {
  get traceId(): Option.Option<TraceId> {
    return this.trace._tag === "Traced" ? Option.some(this.trace.traceId) : Option.none();
  }

  get spanId(): Option.Option<SpanId> {
    return this.trace._tag === "Traced" ? Option.some(this.trace.spanId) : Option.none();
  }
}

export const CorrelationField = Schema.Literals(["traceId", "spanId", "requestId", "runId"]);
export type CorrelationField = typeof CorrelationField.Type;

export class InvalidCorrelationContext extends Schema.TaggedError<InvalidCorrelationContext>()(
  "InvalidCorrelationContext",
  {
    code: Schema.Literal("OBS_CORRELATION_INVALID"),
    message: Schema.String,
    field: CorrelationField,
    rule: Schema.String,
  },
) {}

const invalidCorrelation = (field: CorrelationField, rule: string): InvalidCorrelationContext =>
  new InvalidCorrelationContext({
    code: "OBS_CORRELATION_INVALID",
    field,
    rule,
    message: `Correlation field ${field} is invalid. Use ${rule}.`,
  });

const traceIdRule = "32 lowercase hexadecimal characters and a non-zero value";
const spanIdRule = "16 lowercase hexadecimal characters and a non-zero value";
const opaqueIdentifierRule = "1 to 128 characters without control characters";
const decodeTraceId = Schema.decodeUnknownEffect(TraceId);
const decodeSpanId = Schema.decodeUnknownEffect(SpanId);
const decodeRequestId = Schema.decodeUnknownEffect(RequestId);
const decodeRunId = Schema.decodeUnknownEffect(RunId);

export const parseTraceId = (value: string): Effect.Effect<TraceId, InvalidCorrelationContext> =>
  decodeTraceId(value).pipe(Effect.mapError(() => invalidCorrelation("traceId", traceIdRule)));

export const parseSpanId = (value: string): Effect.Effect<SpanId, InvalidCorrelationContext> =>
  decodeSpanId(value).pipe(Effect.mapError(() => invalidCorrelation("spanId", spanIdRule)));

export const parseRequestId = (
  value: string,
): Effect.Effect<RequestId, InvalidCorrelationContext> =>
  decodeRequestId(value).pipe(
    Effect.mapError(() => invalidCorrelation("requestId", opaqueIdentifierRule)),
  );

export const parseRunId = (value: string): Effect.Effect<RunId, InvalidCorrelationContext> =>
  decodeRunId(value).pipe(Effect.mapError(() => invalidCorrelation("runId", opaqueIdentifierRule)));

const dnsSafeLabel = (label: string): string => {
  const normalized = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized === "" ? "run" : normalized;
};

export const generateRunId = Effect.fn("generateRunId")(function* (
  kind: "job" | "canary",
  label: string,
): Effect.fn.Return<RunId> {
  const prefix = kind === "canary" ? "test" : "job";
  const timestamp = yield* Clock.currentTimeMillis;
  const entropy = Math.floor((yield* Random.next) * 2_821_109_907_456)
    .toString(36)
    .padStart(8, "0");
  const suffix = `-${timestamp}-${entropy}`;
  const truncatedLabel = dnsSafeLabel(label)
    .slice(0, 128 - prefix.length - suffix.length - 1)
    .replaceAll(/-+$/g, "");
  const boundedLabel = truncatedLabel === "" ? "run" : truncatedLabel;
  return yield* decodeRunId(`${prefix}-${boundedLabel}${suffix}`).pipe(Effect.orDie);
});

const emptyCorrelation = new CorrelationContext({});

export const CurrentCorrelation = Context.Reference<CorrelationContext>(
  "@equipe-tech/observability/CurrentCorrelation",
  { defaultValue: () => emptyCorrelation },
);

export const withCorrelation =
  (correlation: CorrelationContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentCorrelation, correlation);

export const withBackgroundCorrelation =
  (correlation: CorrelationContext, spanName: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const correlated = Effect.provideService(effect, CurrentCorrelation, correlation);
    if (correlation.trace._tag === "Traced") {
      return correlated.pipe(
        Effect.withSpan(spanName, {
          parent: Tracer.externalSpan({
            traceId: correlation.trace.traceId,
            spanId: correlation.trace.spanId,
          }),
        }),
      );
    }
    return correlated.pipe(Effect.withSpan(spanName, { root: true }));
  };
