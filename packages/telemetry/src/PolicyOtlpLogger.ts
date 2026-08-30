import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Logger,
  Option,
  Predicate,
  References,
  Schema,
} from "effect";
import type * as LogLevel from "effect/LogLevel";
import type { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpResource, OtlpSerialization } from "effect/unstable/observability";
import { CurrentDataPolicy } from "./policy/DataPolicy.ts";
import { sanitizeText, transformSignalFields } from "./policy/PolicyTransform.ts";
import { effectDroppedAttributesKey } from "./policy/PolicyVocabulary.ts";

interface LogRecord {
  readonly severityNumber: number;
  readonly severityText: string;
  readonly timeUnixNano: string;
  readonly observedTimeUnixNano: string;
  readonly attributes: Array<OtlpResource.KeyValue>;
  readonly body: OtlpResource.AnyValue;
  readonly droppedAttributesCount: number;
  traceId?: string;
  spanId?: string;
}

const Scalar = Schema.Union([
  Schema.String,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
]);
const decodeScalar = Schema.decodeUnknownOption(Scalar);

export const logLevelSeverityNumber = (level: LogLevel.LogLevel): number => {
  switch (level) {
    case "Trace":
      return 1;
    case "Debug":
      return 5;
    case "Info":
      return 9;
    case "Warn":
      return 13;
    case "Error":
      return 17;
    case "Fatal":
      return 21;
    case "All":
    case "None":
      return 0;
  }
};

export type PolicyOtlpLoggerOptions = {
  readonly url: string;
  readonly resource?:
    | {
        readonly serviceName?: string | undefined;
        readonly serviceVersion?: string | undefined;
        readonly attributes?: { readonly [key: string]: string } | undefined;
      }
    | undefined;
  readonly shutdownTimeout?: Duration.Input | undefined;
};

export const makePolicyOtlpLogger = Effect.fn("makePolicyOtlpLogger")(function* (
  options: PolicyOtlpLoggerOptions,
) {
  const serialization = yield* OtlpSerialization.OtlpSerialization;
  const resource = yield* OtlpResource.fromConfig(options.resource);
  const clock = yield* Clock.Clock;
  const existingLoggers = yield* Logger.CurrentLoggers;
  const exporter = yield* OtlpExporter.make({
    label: "PolicyOtlpLogger",
    url: options.url,
    headers: undefined,
    maxBatchSize: 1000,
    exportInterval: Duration.seconds(1),
    body: (records) => [
      serialization.logs({
        resourceLogs: [
          {
            resource,
            scopeLogs: [
              {
                scope: { name: OtlpResource.serviceNameUnsafe(resource) },
                logRecords: records,
              },
            ],
          },
        ],
      }),
      Effect.void,
    ],
    shutdownTimeout: options.shutdownTimeout ?? Duration.seconds(3),
  });
  return Logger.make((entry) => {
    const policy = entry.fiber.getRef(CurrentDataPolicy);
    const raw: { [key: string]: string | number | boolean } = {};
    let unsupportedDropped = 0;
    for (const [key, value] of Object.entries(
      entry.fiber.getRef(References.CurrentLogAnnotations),
    )) {
      const decoded = decodeScalar(value);
      if (Option.isSome(decoded)) {
        raw[key] = decoded.value;
      } else {
        unsupportedDropped += 1;
      }
    }
    const packageGeneratedKeys = new Set<string>();
    raw["effect.fiber.id"] = entry.fiber.id;
    packageGeneratedKeys.add("effect.fiber.id");
    const nowMillis = entry.date.getTime();
    for (const [label, startTime] of entry.fiber.getRef(References.CurrentLogSpans)) {
      const key = `effect.log_span.${label}`;
      raw[key] = `${nowMillis - startTime}ms`;
      packageGeneratedKeys.add(key);
    }
    const sanitizedCause =
      entry.cause.reasons.length > 0
        ? sanitizeText(policy, Cause.pretty(entry.cause), "log")
        : undefined;
    if (sanitizedCause !== undefined) {
      raw["log.error"] = sanitizedCause;
      packageGeneratedKeys.add("log.error");
    }
    const decision = transformSignalFields(policy, "log", raw);
    const delegatedAnnotations = Object.fromEntries(
      Object.entries(decision.value).filter(([key]) => !packageGeneratedKeys.has(key)),
    );
    const now = clock.currentTimeNanosUnsafe().toString();
    const attributes = OtlpResource.entriesToAttributes(Object.entries(decision.value));
    const messages = Arr.ensure(entry.message).map((message) => {
      const decoded = decodeScalar(message);
      if (Option.isSome(decoded)) {
        return Predicate.isString(decoded.value)
          ? sanitizeText(policy, decoded.value, "log")
          : decoded.value;
      }
      return "[REDACTED]";
    });
    const sanitizedFiber: typeof entry.fiber = Object.create(entry.fiber);
    Object.defineProperty(sanitizedFiber, "getRef", {
      value: (reference: Context.Reference<unknown>) =>
        reference === References.CurrentLogAnnotations
          ? {
              ...delegatedAnnotations,
              [effectDroppedAttributesKey]: decision.dropped + unsupportedDropped,
            }
          : entry.fiber.getRef(reference),
    });
    const sanitizedEntry = {
      ...entry,
      message: messages,
      fiber: sanitizedFiber,
      cause: sanitizedCause === undefined ? Cause.empty : Cause.fail(sanitizedCause),
    };
    for (const logger of existingLoggers) logger.log(sanitizedEntry);
    const record: LogRecord = {
      severityNumber: logLevelSeverityNumber(entry.logLevel),
      severityText: entry.logLevel,
      timeUnixNano: now,
      observedTimeUnixNano: now,
      attributes,
      body: OtlpResource.unknownToAttributeValue(messages.length === 1 ? messages[0] : messages),
      droppedAttributesCount: decision.dropped + unsupportedDropped,
    };
    if (entry.fiber.currentSpan) {
      record.traceId = entry.fiber.currentSpan.traceId;
      record.spanId = entry.fiber.currentSpan.spanId;
    }
    exporter.push(record);
  });
});

export const layerPolicyOtlpLogger = (
  options: PolicyOtlpLoggerOptions,
): Layer.Layer<
  OtlpExporter.Flusher,
  never,
  HttpClient.HttpClient | OtlpSerialization.OtlpSerialization
> =>
  Logger.layer([makePolicyOtlpLogger(options)], { mergeWithExisting: false }).pipe(
    Layer.provideMerge(OtlpExporter.layerFlusher),
  );
