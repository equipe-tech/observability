import { assert, describe, it } from "@effect/vitest";
import { Effect, Metric, Option, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Telemetry } from "../src/index.ts";
import { ingestBrowserEvents } from "../src/node/index.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import * as WideEvent from "../src/WideEvent.ts";

const observabilityHome =
  process.env["OBSERVABILITY_HOME"] ?? join(homedir(), ".local", "state", "observability");
const telemetryExportPath =
  process.env["OBSERVABILITY_EXPORT_PATH"] ??
  join(observabilityHome, "0.1.0", "data", "otlp.jsonl");

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
      resource: ExportedResource,
      scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(ExportedLogRecord) })),
    }),
  ),
});

const MetricDataPoint = Schema.Struct({
  attributes: Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  asDouble: Schema.Number.pipe(Schema.optionalKey),
  asInt: Schema.Number.pipe(Schema.optionalKey),
});

const ExportedMetric = Schema.Struct({
  name: Schema.String,
  sum: Schema.Struct({ dataPoints: Schema.Array(MetricDataPoint) }).pipe(Schema.optionalKey),
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

type CanarySpan = typeof ExportedSpan.Type;
type CanaryResource = typeof ExportedResource.Type;
type CanaryLogRecord = typeof ExportedLogRecord.Type;
type CanaryMetric = typeof ExportedMetric.Type;
type CanaryMetricDataPoint = typeof MetricDataPoint.Type;

type CanaryExport = {
  readonly spans: ReadonlyArray<{ readonly span: CanarySpan; readonly resource: CanaryResource }>;
  readonly logs: ReadonlyArray<{
    readonly log: CanaryLogRecord;
    readonly resource: CanaryResource;
  }>;
  readonly metrics: ReadonlyArray<{
    readonly metric: CanaryMetric;
    readonly dataPoint: CanaryMetricDataPoint;
    readonly resource: CanaryResource;
  }>;
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
  const logs: Array<{ log: CanaryLogRecord; resource: CanaryResource }> = [];
  const metrics: Array<{
    metric: CanaryMetric;
    dataPoint: CanaryMetricDataPoint;
    resource: CanaryResource;
  }> = [];
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
          for (const log of scopeLogs.logRecords) {
            logs.push({ log, resource: resourceLogs.resource });
          }
        }
      }
    }
    const metricExport = yield* decodeMetricExport(parsed.value).pipe(Effect.option);
    if (Option.isSome(metricExport)) {
      for (const resourceMetrics of metricExport.value.resourceMetrics) {
        for (const scopeMetrics of resourceMetrics.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            for (const dataPoint of metric.sum?.dataPoints ?? []) {
              metrics.push({ metric, dataPoint, resource: resourceMetrics.resource });
            }
          }
        }
      }
    }
  }
  return { spans, logs, metrics };
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
        (candidate) =>
          Option.getOrUndefined(attributeValue(candidate.log.attributes, "canary.run_id")) ===
            runId &&
          Option.getOrUndefined(attributeValue(candidate.log.attributes, "event.name")) ===
            "canary.completed",
      );
      const browserLog = telemetryExport.logs.find(
        (candidate) =>
          Option.getOrUndefined(attributeValue(candidate.log.attributes, "canary.run_id")) ===
            runId &&
          Option.getOrUndefined(attributeValue(candidate.log.attributes, "event.name")) ===
            "canary.browser",
      );
      const metric = telemetryExport.metrics.find(
        (candidate) =>
          candidate.metric.name === "canary.operations" &&
          Option.getOrUndefined(attributeValue(candidate.dataPoint.attributes, "canary.run_id")) ===
            runId,
      );
      if (
        child !== undefined &&
        log !== undefined &&
        browserLog !== undefined &&
        metric !== undefined
      ) {
        return { root, child, log, browserLog, metric };
      }
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(`canary run ${runId} not found in ${telemetryExportPath}`);
});

const canaryEnabled = process.env["OBSERVABILITY_E2E"] === "1";

describe.runIf(canaryEnabled)("pipeline canary", () => {
  it.live(
    "exports correlated traces, logs and metrics through the collector",
    () =>
      Effect.gen(function* () {
        const runId = `canary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const config = new TelemetryConfig({
          serviceName: "observability-canary",
          serviceVersion: "0.1.0",
          environment: "test",
          otlpEndpoint: new URL("http://localhost:4318"),
        });

        yield* Effect.gen(function* () {
          const operationCounter = Metric.counter("canary.operations", {
            attributes: { "canary.run_id": runId },
          });
          yield* Effect.sleep("10 millis").pipe(Effect.withSpan("canary.child"));
          yield* WideEvent.emit("canary.completed", { "canary.run_id": runId });
          yield* ingestBrowserEvents({
            version: 1,
            events: [
              {
                id: `browser-${runId}`,
                name: "canary.browser",
                occurredAt: Date.now(),
                fields: { "canary.run_id": runId },
              },
            ],
          }).pipe(Effect.orDie);
          yield* Metric.update(operationCounter, 1);
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

        assert.strictEqual(run.log.log.traceId, run.root.span.traceId);
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(run.log.log.attributes, "event.kind")),
          "wide",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(run.log.log.attributes, "event.name")),
          "canary.completed",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(run.browserLog.log.attributes, "event.source")),
          "browser",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(run.browserLog.log.attributes, "browser.event.id")),
          `browser-${runId}`,
        );
        assert.strictEqual(run.metric.metric.name, "canary.operations");
        assert.strictEqual(run.metric.dataPoint.asDouble, 1);

        for (const signalResource of [run.log.resource, run.metric.resource]) {
          assert.strictEqual(
            Option.getOrUndefined(attributeValue(signalResource.attributes, "service.name")),
            "observability-canary",
          );
          assert.strictEqual(
            Option.getOrUndefined(attributeValue(signalResource.attributes, "service.version")),
            "0.1.0",
          );
          assert.strictEqual(
            Option.getOrUndefined(
              attributeValue(signalResource.attributes, "deployment.environment.name"),
            ),
            "test",
          );
        }
      }),
    60_000,
  );
});
