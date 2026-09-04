import { Effect, Option, Schema } from "effect";
import { createServer, type Server } from "node:http";
import type { CapturedTelemetry } from "@equipe-tech/observability/testing";

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

const ExportedSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.String.pipe(Schema.optionalKey),
  attributes: Attributes,
  resourceAttributes: Attributes,
});

const SpanExport = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({ attributes: Attributes }),
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(ExportedSpan) })),
    }),
  ),
});

const ExportedLogRecord = Schema.Struct({
  traceId: Schema.String.pipe(Schema.optionalKey),
  spanId: Schema.String.pipe(Schema.optionalKey),
  attributes: Attributes,
  resourceAttributes: Attributes,
});

const LogExport = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({ attributes: Attributes }),
      scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(ExportedLogRecord) })),
    }),
  ),
});

const decodeSpanExport = Schema.decodeUnknownSync(SpanExport);
const decodeLogExport = Schema.decodeUnknownSync(LogExport);
const decodeServerAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));

type SpanExportBatch = ReturnType<typeof decodeSpanExport>;
type LogExportBatch = ReturnType<typeof decodeLogExport>;

const toAttributes = (attributes: ReadonlyArray<typeof Attribute.Type>) => {
  const converted = new Map<string, string | number | boolean>();
  for (const attribute of attributes) {
    const value = attribute.value;
    if (value.stringValue !== undefined) converted.set(attribute.key, value.stringValue);
    else if (value.boolValue !== undefined) converted.set(attribute.key, value.boolValue);
    else if (value.intValue !== undefined) converted.set(attribute.key, Number(value.intValue));
    else if (value.doubleValue !== undefined) converted.set(attribute.key, value.doubleValue);
  }
  return converted;
};

export type LocalCollector = {
  readonly endpoint: URL;
  readonly telemetry: () => CapturedTelemetry;
  readonly stop: () => Promise<void>;
};

export const startLocalCollector = async (): Promise<LocalCollector> => {
  const spanExports: Array<SpanExportBatch> = [];
  const logExports: Array<LogExportBatch> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/v1/traces") === true) {
        spanExports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      }
      if (request.url?.endsWith("/v1/logs") === true) {
        logExports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = decodeServerAddress(server.address());
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}`),
    telemetry: (): CapturedTelemetry => {
      const spans: Array<CapturedTelemetry["spans"][number]> = [];
      for (const exported of spanExports) {
        for (const resourceSpans of exported.resourceSpans) {
          const resourceAttributes = toAttributes(resourceSpans.resource.attributes);
          for (const scope of resourceSpans.scopeSpans) {
            for (const span of scope.spans) {
              spans.push({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: Option.fromNullishOr(span.parentSpanId),
                name: "fixture-span",
                kind: 0,
                statusCode: 0,
                statusMessage: Option.none(),
                attributes: toAttributes(span.attributes),
                droppedAttributesCount: 0,
                events: [],
                droppedEventsCount: 0,
                links: [],
                droppedLinksCount: 0,
                eventNames: [],
                linkedSpanIds: [],
                resourceAttributes,
              });
            }
          }
        }
      }
      const logs: Array<CapturedTelemetry["logs"][number]> = [];
      for (const exported of logExports) {
        for (const resourceLogs of exported.resourceLogs) {
          const resourceAttributes = toAttributes(resourceLogs.resource.attributes);
          for (const scope of resourceLogs.scopeLogs) {
            for (const log of scope.logRecords) {
              logs.push({
                traceId: Option.fromNullishOr(log.traceId),
                spanId: Option.fromNullishOr(log.spanId),
                severityText: Option.none(),
                droppedAttributesCount: 0,
                body: Option.none(),
                attributes: toAttributes(log.attributes),
                resourceAttributes,
              });
            }
          }
        }
      }
      return { spans, logs, metrics: [] };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
