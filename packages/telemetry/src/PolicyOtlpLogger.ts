import {
  Array as Arr,
  Cause,
  Clock,
  Console,
  Duration,
  Effect,
  Layer,
  Logger,
  Option,
  Predicate,
  References,
  Schema,
} from "effect";
import type { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpResource, OtlpSerialization } from "effect/unstable/observability";
import { CurrentDataPolicy } from "./policy/DataPolicy.ts";
import { sanitizeSignalFields } from "./policy/SignalPolicy.ts";
import { sanitizeText } from "./policy/PolicyTransform.ts";

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

const severityNumber = (level: string): number => {
  switch (level) {
    case "All":
      return 1;
    case "Trace":
      return 1;
    case "Debug":
      return 5;
    case "Info":
      return 9;
    case "Warning":
      return 13;
    case "Error":
      return 17;
    case "Fatal":
      return 21;
    case "None":
      return 0;
    default:
      return 0;
  }
};

export type PolicyOtlpLoggerOptions = {
  readonly url: string;
  readonly resource: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly attributes: { readonly [key: string]: string };
  };
  readonly shutdownTimeout?: Duration.Input | undefined;
};

export const makePolicyOtlpLogger = Effect.fn("makePolicyOtlpLogger")(function* (
  options: PolicyOtlpLoggerOptions,
) {
  const serialization = yield* OtlpSerialization.OtlpSerialization;
  const resource = yield* OtlpResource.fromConfig(options.resource);
  const clock = yield* Clock.Clock;
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
    for (const [key, value] of Object.entries(
      entry.fiber.getRef(References.CurrentLogAnnotations),
    )) {
      const decoded = decodeScalar(value);
      if (Option.isSome(decoded)) raw[key] = decoded.value;
    }
    const decision = sanitizeSignalFields(policy, "log", raw);
    const now = clock.currentTimeNanosUnsafe().toString();
    const attributes = OtlpResource.entriesToAttributes(Object.entries(decision.value));
    attributes.push({ key: "fiberId", value: { intValue: entry.fiber.id } });
    if (entry.cause.reasons.length > 0) {
      attributes.push({
        key: "log.error",
        value: { stringValue: sanitizeText(policy, Cause.pretty(entry.cause)) },
      });
    }
    const messages = Arr.ensure(entry.message).map((message) => {
      const decoded = decodeScalar(message);
      if (Option.isSome(decoded)) {
        return Predicate.isString(decoded.value)
          ? sanitizeText(policy, decoded.value)
          : decoded.value;
      }
      return "[REDACTED]";
    });
    const currentSpan = entry.fiber.currentSpan;
    if (currentSpan !== undefined && currentSpan._tag !== "ExternalSpan") {
      currentSpan.event(
        messages.map((message) => String(message)).join(" "),
        clock.currentTimeNanosUnsafe(),
        {
          ...decision.value,
          "effect.fiber_id": entry.fiber.id,
          "effect.log_level": entry.logLevel,
        },
      );
    }
    const console = entry.fiber.getRef(Console.Console);
    console.log(`[${entry.logLevel}]`, ...messages, decision.value);
    const record: LogRecord = {
      severityNumber: severityNumber(entry.logLevel),
      severityText: entry.logLevel,
      timeUnixNano: now,
      observedTimeUnixNano: now,
      attributes,
      body: OtlpResource.unknownToAttributeValue(messages.length === 1 ? messages[0] : messages),
      droppedAttributesCount: decision.dropped,
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
