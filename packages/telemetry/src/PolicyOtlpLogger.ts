import {
  Array as Arr,
  Cause,
  Clock,
  Console,
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
import type { Headers, HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpResource, OtlpSerialization } from "effect/unstable/observability";
import { CurrentDataPolicy } from "./policy/DataPolicy.ts";
import { sanitizeText, transformSignalFields } from "./policy/PolicyTransform.ts";

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
  readonly headers?: Headers.Input | undefined;
  readonly exportInterval?: Duration.Input | undefined;
  readonly maxBatchSize?: number | undefined;
  readonly shutdownTimeout?: Duration.Input | undefined;
  readonly excludeLogSpans?: boolean | undefined;
  readonly mergeWithExisting?: boolean | undefined;
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
    headers: options.headers,
    maxBatchSize: options.maxBatchSize ?? 1000,
    exportInterval: options.exportInterval ?? Duration.seconds(1),
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
    const decision = transformSignalFields(policy, "log", raw);
    const now = clock.currentTimeNanosUnsafe().toString();
    const attributes = OtlpResource.entriesToAttributes(Object.entries(decision.value));
    attributes.push({ key: "fiberId", value: { intValue: entry.fiber.id } });
    if (!options.excludeLogSpans) {
      const nowMillis = entry.date.getTime();
      for (const [label, startTime] of entry.fiber.getRef(References.CurrentLogSpans)) {
        attributes.push({
          key: `logSpan.${label}`,
          value: { stringValue: `${nowMillis - startTime}ms` },
        });
      }
    }
    const sanitizedCause =
      entry.cause.reasons.length > 0
        ? sanitizeText(policy, Cause.pretty(entry.cause), "log")
        : undefined;
    if (sanitizedCause !== undefined) {
      attributes.push({
        key: "log.error",
        value: { stringValue: sanitizedCause },
      });
    }
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
          ? decision.value
          : entry.fiber.getRef(reference),
    });
    if (options.mergeWithExisting !== false) {
      const sanitizedEntry = {
        ...entry,
        message: messages,
        fiber: sanitizedFiber,
        cause: sanitizedCause === undefined ? Cause.empty : Cause.fail(sanitizedCause),
      };
      for (const logger of existingLoggers) logger.log(sanitizedEntry);
    } else {
      const console = entry.fiber.getRef(Console.Console);
      console.log(`[${entry.logLevel}]`, ...messages, decision.value);
    }
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
