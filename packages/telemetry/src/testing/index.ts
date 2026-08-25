import { Effect, Layer, Option, Ref, Schema, type Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { layerOtlp } from "../Telemetry.ts";
import { TelemetryConfig } from "../TelemetryConfig.ts";

export type CapturedAttributeValue = string | number | boolean;

export type CapturedAttributes = ReadonlyMap<string, CapturedAttributeValue>;

export type CapturedSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: Option.Option<string>;
  readonly name: string;
  readonly statusCode: number;
  readonly statusMessage: Option.Option<string>;
  readonly attributes: CapturedAttributes;
  readonly resourceAttributes: CapturedAttributes;
};

export type CapturedLog = {
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly severityText: Option.Option<string>;
  readonly body: Option.Option<string>;
  readonly attributes: CapturedAttributes;
  readonly resourceAttributes: CapturedAttributes;
};

export type CapturedMetricPoint = {
  readonly value: Option.Option<number>;
  readonly attributes: CapturedAttributes;
};

export type CapturedMetric = {
  readonly name: string;
  readonly points: ReadonlyArray<CapturedMetricPoint>;
  readonly resourceAttributes: CapturedAttributes;
};

export type CapturedTelemetry = {
  readonly spans: ReadonlyArray<CapturedSpan>;
  readonly logs: ReadonlyArray<CapturedLog>;
  readonly metrics: ReadonlyArray<CapturedMetric>;
};

export type TelemetryRun<A, E> = {
  readonly exit: Exit.Exit<A, E>;
  readonly telemetry: CapturedTelemetry;
};

const AttributeValue = Schema.Struct({
  stringValue: Schema.String.pipe(Schema.optionalKey),
  boolValue: Schema.Boolean.pipe(Schema.optionalKey),
  intValue: Schema.Union([Schema.String, Schema.Number]).pipe(Schema.optionalKey),
  doubleValue: Schema.Number.pipe(Schema.optionalKey),
});

const Attribute = Schema.Struct({
  key: Schema.String,
  value: AttributeValue,
});

const Attributes = Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([])));

const ExportedResource = Schema.Struct({
  attributes: Attributes,
});

const ExportedSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.String.pipe(Schema.optionalKey),
  name: Schema.String,
  status: Schema.Struct({
    code: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    message: Schema.String.pipe(Schema.optionalKey),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({ code: 0 }))),
  attributes: Attributes,
});

const SpanExport = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: ExportedResource,
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(ExportedSpan) })),
    }),
  ),
});

const ExportedLogRecord = Schema.Struct({
  traceId: Schema.String.pipe(Schema.optionalKey),
  spanId: Schema.String.pipe(Schema.optionalKey),
  severityText: Schema.String.pipe(Schema.optionalKey),
  body: Schema.Struct({ stringValue: Schema.String.pipe(Schema.optionalKey) }).pipe(
    Schema.optionalKey,
  ),
  attributes: Attributes,
});

const LogExport = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      resource: ExportedResource,
      scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(ExportedLogRecord) })),
    }),
  ),
});

const MetricDataPoint = Schema.Struct({
  attributes: Attributes,
  asDouble: Schema.Number.pipe(Schema.optionalKey),
  asInt: Schema.Union([Schema.String, Schema.Number]).pipe(Schema.optionalKey),
});

const DataPoints = Schema.Struct({ dataPoints: Schema.Array(MetricDataPoint) });

const ExportedMetric = Schema.Struct({
  name: Schema.String,
  sum: DataPoints.pipe(Schema.optionalKey),
  gauge: DataPoints.pipe(Schema.optionalKey),
});

const MetricExport = Schema.Struct({
  resourceMetrics: Schema.Array(
    Schema.Struct({
      resource: ExportedResource,
      scopeMetrics: Schema.Array(Schema.Struct({ metrics: Schema.Array(ExportedMetric) })),
    }),
  ),
});

const decodeSpanExport = Schema.decodeUnknownEffect(SpanExport);
const decodeLogExport = Schema.decodeUnknownEffect(LogExport);
const decodeMetricExport = Schema.decodeUnknownEffect(MetricExport);

type ExportedAttribute = typeof Attribute.Type;

const toAttributes = (attributes: ReadonlyArray<ExportedAttribute>): CapturedAttributes => {
  const converted = new Map<string, CapturedAttributeValue>();
  for (const attribute of attributes) {
    const value = attribute.value;
    if (value.stringValue !== undefined) {
      converted.set(attribute.key, value.stringValue);
    } else if (value.boolValue !== undefined) {
      converted.set(attribute.key, value.boolValue);
    } else if (value.intValue !== undefined) {
      converted.set(attribute.key, Number(value.intValue));
    } else if (value.doubleValue !== undefined) {
      converted.set(attribute.key, value.doubleValue);
    }
  }
  return converted;
};

export const attribute = (
  attributes: CapturedAttributes,
  key: string,
): Option.Option<CapturedAttributeValue> => Option.fromNullishOr(attributes.get(key));

export type CapturedRequest = {
  readonly path: string;
  readonly payload: unknown;
};

const captureClient = (store: Ref.Ref<ReadonlyArray<CapturedRequest>>): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = request.body;
      if (body._tag === "Uint8Array") {
        const payload = yield* Effect.try((): unknown =>
          JSON.parse(new TextDecoder().decode(body.body)),
        ).pipe(Effect.option);
        if (Option.isSome(payload)) {
          yield* Ref.update(store, (requests) => [
            ...requests,
            { path: url.pathname, payload: payload.value },
          ]);
        }
      }
      return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
    }),
  );

const decodeCapturedTelemetry = Effect.fn("decodeCapturedTelemetry")(function* (
  requests: ReadonlyArray<CapturedRequest>,
): Effect.fn.Return<CapturedTelemetry, never> {
  const spans: Array<CapturedSpan> = [];
  const logs: Array<CapturedLog> = [];
  const metrics: Array<CapturedMetric> = [];
  for (const request of requests) {
    if (request.path.endsWith("/v1/traces")) {
      const spanExport = yield* decodeSpanExport(request.payload).pipe(Effect.orDie);
      for (const resourceSpans of spanExport.resourceSpans) {
        const resourceAttributes = toAttributes(resourceSpans.resource.attributes);
        for (const scopeSpans of resourceSpans.scopeSpans) {
          for (const span of scopeSpans.spans) {
            spans.push({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: Option.fromNullishOr(span.parentSpanId),
              name: span.name,
              statusCode: span.status.code,
              statusMessage: Option.fromNullishOr(span.status.message),
              attributes: toAttributes(span.attributes),
              resourceAttributes,
            });
          }
        }
      }
    } else if (request.path.endsWith("/v1/logs")) {
      const logExport = yield* decodeLogExport(request.payload).pipe(Effect.orDie);
      for (const resourceLogs of logExport.resourceLogs) {
        const resourceAttributes = toAttributes(resourceLogs.resource.attributes);
        for (const scopeLogs of resourceLogs.scopeLogs) {
          for (const log of scopeLogs.logRecords) {
            logs.push({
              traceId: Option.fromNullishOr(log.traceId),
              spanId: Option.fromNullishOr(log.spanId),
              severityText: Option.fromNullishOr(log.severityText),
              body: Option.fromNullishOr(log.body?.stringValue),
              attributes: toAttributes(log.attributes),
              resourceAttributes,
            });
          }
        }
      }
    } else if (request.path.endsWith("/v1/metrics")) {
      const metricExport = yield* decodeMetricExport(request.payload).pipe(Effect.orDie);
      for (const resourceMetrics of metricExport.resourceMetrics) {
        const resourceAttributes = toAttributes(resourceMetrics.resource.attributes);
        for (const scopeMetrics of resourceMetrics.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
            metrics.push({
              name: metric.name,
              points: dataPoints.map((dataPoint) => ({
                value: Option.fromNullishOr(dataPoint.asDouble ?? dataPoint.asInt).pipe(
                  Option.map(Number),
                ),
                attributes: toAttributes(dataPoint.attributes),
              })),
              resourceAttributes,
            });
          }
        }
      }
    }
  }
  return { spans, logs, metrics };
});

const defaultConfig = new TelemetryConfig({
  serviceName: "telemetry-testing",
  serviceVersion: "0.0.0",
  environment: "test",
  otlpEndpoint: new URL("http://telemetry.invalid"),
});

export type RunOptions = {
  readonly config?: TelemetryConfig;
};

export type TelemetryCapture = {
  readonly layer: Layer.Layer<never>;
  readonly telemetry: Effect.Effect<CapturedTelemetry>;
};

export const makeCapture = Effect.fn("makeCapture")(function* (
  options?: RunOptions,
): Effect.fn.Return<TelemetryCapture, never> {
  const store = yield* Ref.make<ReadonlyArray<CapturedRequest>>([]);
  const layer = layerOtlp(options?.config ?? defaultConfig).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, captureClient(store))),
  );
  const telemetry = Ref.get(store).pipe(Effect.flatMap(decodeCapturedTelemetry));
  return { layer, telemetry };
});

export const run = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options?: RunOptions,
): Effect.Effect<TelemetryRun<A, E>, never, R> =>
  Effect.gen(function* () {
    const capture = yield* makeCapture(options);
    const exit = yield* program.pipe(Effect.provide(capture.layer), Effect.exit);
    const telemetry = yield* capture.telemetry;
    return { exit, telemetry };
  });
