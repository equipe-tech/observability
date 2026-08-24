import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { Telemetry } from "../src/index.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import * as WideEvent from "../src/WideEvent.ts";

const telemetryExportPath = new URL("../../../compose/data/otlp.jsonl", import.meta.url);

const AttributeValue = Schema.Struct({
  stringValue: Schema.String.pipe(Schema.optionalKey),
});

const Attribute = Schema.Struct({
  key: Schema.String,
  value: AttributeValue,
});

const ExportedSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.String.pipe(Schema.optionalKey),
  name: Schema.String,
  attributes: Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const ExportedResource = Schema.Struct({
  attributes: Schema.Array(Attribute),
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
  attributes: Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const LogExport = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(ExportedLogRecord) })),
    }),
  ),
});

const decodeSpanExport = Schema.decodeUnknownEffect(SpanExport);
const decodeLogExport = Schema.decodeUnknownEffect(LogExport);

type CanarySpan = typeof ExportedSpan.Type;
type CanaryResource = typeof ExportedResource.Type;
type CanaryLogRecord = typeof ExportedLogRecord.Type;

type CanaryExport = {
  readonly spans: ReadonlyArray<{ readonly span: CanarySpan; readonly resource: CanaryResource }>;
  readonly logs: ReadonlyArray<CanaryLogRecord>;
};

const attributeValue = (
  attributes: ReadonlyArray<typeof Attribute.Type>,
  key: string,
): Option.Option<string> =>
  Option.fromNullishOr(attributes.find((attribute) => attribute.key === key)).pipe(
    Option.flatMap((attribute) => Option.fromNullishOr(attribute.value.stringValue)),
  );

const readTelemetryExport = Effect.fn("readTelemetryExport")(function* (): Effect.fn.Return<
  CanaryExport,
  never
> {
  const content = yield* Effect.promise(() => readFile(telemetryExportPath, "utf8")).pipe(
    Effect.catch(() => Effect.succeed("")),
  );
  const spans: Array<{ span: CanarySpan; resource: CanaryResource }> = [];
  const logs: Array<CanaryLogRecord> = [];
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const parsed = yield* Effect.try((): unknown => JSON.parse(line)).pipe(Effect.option);
    if (Option.isNone(parsed)) continue;
    const spanExport = yield* decodeSpanExport(parsed.value).pipe(Effect.option);
    if (Option.isSome(spanExport)) {
      for (const resourceSpans of spanExport.value.resourceSpans) {
        for (const scopeSpans of resourceSpans.scopeSpans) {
          for (const span of scopeSpans.spans) {
            spans.push({ span, resource: resourceSpans.resource });
          }
        }
      }
    }
    const logExport = yield* decodeLogExport(parsed.value).pipe(Effect.option);
    if (Option.isSome(logExport)) {
      for (const resourceLogs of logExport.value.resourceLogs) {
        for (const scopeLogs of resourceLogs.scopeLogs) {
          logs.push(...scopeLogs.logRecords);
        }
      }
    }
  }
  return { spans, logs };
});

const findRun = Effect.fn("findRun")(function* (runId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const telemetryExport = yield* readTelemetryExport();
    const root = telemetryExport.spans.find(
      (candidate) =>
        Option.getOrUndefined(attributeValue(candidate.span.attributes, "canary.run_id")) === runId,
    );
    if (root !== undefined) {
      const child = telemetryExport.spans.find(
        (candidate) =>
          candidate.span.parentSpanId === root.span.spanId &&
          candidate.span.traceId === root.span.traceId,
      );
      const log = telemetryExport.logs.find(
        (record) =>
          Option.getOrUndefined(attributeValue(record.attributes, "canary.run_id")) === runId,
      );
      if (child !== undefined && log !== undefined) {
        return { root, child, log };
      }
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(`canary run ${runId} not found in ${telemetryExportPath.pathname}`);
});

const canaryEnabled = process.env["OBSERVABILITY_E2E"] === "1";

describe.runIf(canaryEnabled)("pipeline canary", () => {
  it.live(
    "exports a trace, parentage, resource attributes and a wide event through the collector",
    () =>
      Effect.gen(function* () {
        const runId = `canary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const config = new TelemetryConfig({
          serviceName: "observability-canary",
          serviceVersion: "0.1.0",
          environment: "test",
          otlpEndpoint: "http://localhost:4318",
        });

        yield* Effect.gen(function* () {
          yield* Effect.sleep("10 millis").pipe(Effect.withSpan("canary.child"));
          yield* WideEvent.emit("canary.completed", { "canary.run_id": runId });
        }).pipe(
          Effect.withSpan("canary.operation", {
            attributes: { "canary.run_id": runId },
          }),
          Effect.provide(Telemetry.layer(config)),
        );

        const run = yield* findRun(runId);

        assert.strictEqual(run.root.span.name, "canary.operation");
        assert.strictEqual(run.child.span.name, "canary.child");
        assert.strictEqual(run.child.span.traceId, run.root.span.traceId);
        assert.strictEqual(run.child.span.parentSpanId, run.root.span.spanId);

        const resource = run.root.resource.attributes;
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(resource, "service.name")),
          "observability-canary",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(resource, "service.version")),
          "0.1.0",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(resource, "deployment.environment.name")),
          "test",
        );

        assert.strictEqual(run.log.traceId, run.root.span.traceId);
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(run.log.attributes, "event.kind")),
          "wide",
        );
      }),
    60_000,
  );
});
