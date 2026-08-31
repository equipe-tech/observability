import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  AuditPublisher,
  commitAuditRecord,
  CorrelationContext,
  defineTelemetryContract,
  parseAuditRecord,
  parseNodeObservabilityConfig,
  parseRunId,
} from "../src/index.ts";
import { createNodeObservabilityFromConfig, layerNodeAuditDigest } from "../src/node/index.ts";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseResourceIdentity } from "../src/ResourceIdentity.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import { canaryRunId, canarySensitiveValues, emitCanary } from "./support/canary.ts";

const cliManifest: unknown = JSON.parse(
  await readFile(new URL("../../cli/package.json", import.meta.url).pathname, "utf8"),
);
const cliVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
  cliManifest,
).version;

const observabilityHome =
  process.env["OBSERVABILITY_HOME"] ?? join(homedir(), ".local", "state", "observability");
const telemetryExportPath =
  process.env["OBSERVABILITY_EXPORT_PATH"] ??
  join(observabilityHome, cliVersion, "data", "otlp.jsonl");

const AttributeValue = Schema.Struct({
  stringValue: Schema.String.pipe(Schema.optionalKey),
});

const Attribute = Schema.Struct({
  key: Schema.String,
  value: AttributeValue,
});

const ExportedSpanEvent = Schema.Struct({
  name: Schema.String,
  attributes: Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const ExportedSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.String.pipe(Schema.optionalKey),
  name: Schema.String,
  attributes: Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  events: Schema.Array(ExportedSpanEvent).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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
  body: Schema.Struct({ stringValue: Schema.String.pipe(Schema.optionalKey) }),
  attributes: Schema.Array(Attribute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const RedactedLogBody = Schema.Struct({
  authorization: Schema.String,
  password: Schema.String,
  token: Schema.String,
  email: Schema.String,
  accessToken: Schema.String,
  userPassword: Schema.String,
  phoneNumber: Schema.String,
  tokenizer: Schema.String,
  documentation: Schema.String,
});

const decodeRedactedLogBody = Schema.decodeUnknownSync(RedactedLogBody);

const AuditCanaryBody = Schema.Struct({
  "audit.record.id": Schema.String,
  "audit.outcome": Schema.String,
  "event.outcome": Schema.String,
  "run.id": Schema.String,
  audit: Schema.Struct({
    actor: Schema.Struct({ id: Schema.String }),
    idempotencyKey: Schema.String,
  }),
});
const decodeAuditCanaryBody = Schema.decodeUnknownOption(AuditCanaryBody);

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
  sum: Schema.Struct({
    dataPoints: Schema.Array(MetricDataPoint).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }).pipe(Schema.optionalKey),
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
  readonly content: string;
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

const assertEnvironmentAliases = (resource: CanaryResource, expected: string): void => {
  const canonical = Option.getOrUndefined(
    attributeValue(resource.attributes, "deployment.environment.name"),
  );
  const legacy = Option.getOrUndefined(
    attributeValue(resource.attributes, "deployment.environment"),
  );
  assert.strictEqual(canonical, expected);
  assert.strictEqual(legacy, canonical);
};

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
  return { content, spans, logs, metrics };
});

const findRun = Effect.fn("findRun")(function* (runId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const telemetryExport = yield* readTelemetryExport();
    const root = telemetryExport.spans.find(
      (candidate) =>
        Option.getOrUndefined(attributeValue(candidate.span.attributes, "canary.run_id")) === runId,
    );
    if (root !== undefined) {
      const redactionSpanEvent = root.span.events.find(
        (event) =>
          Option.getOrUndefined(attributeValue(event.attributes, "event.name")) ===
          "canary.redaction",
      );
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
      const redactionLog = telemetryExport.logs.find(
        (candidate) =>
          Option.getOrUndefined(attributeValue(candidate.log.attributes, "canary.run_id")) ===
            runId &&
          Option.getOrUndefined(attributeValue(candidate.log.attributes, "event.name")) ===
            "canary.redaction",
      );
      const metric = telemetryExport.metrics.find(
        (candidate) =>
          candidate.metric.name === "canary.operations" &&
          Option.getOrUndefined(attributeValue(candidate.dataPoint.attributes, "canary.run_id")) ===
            runId,
      );
      const auditLog = telemetryExport.logs.find((candidate) => {
        const body = candidate.log.body.stringValue;
        if (body === undefined) return false;
        const parsed = Effect.runSync(
          Effect.try((): unknown => JSON.parse(body)).pipe(Effect.option),
        );
        if (Option.isNone(parsed)) return false;
        const decoded = decodeAuditCanaryBody(parsed.value);
        return Option.isSome(decoded) && decoded.value["audit.record.id"] === `audit-${runId}`;
      });
      if (
        redactionSpanEvent !== undefined &&
        child !== undefined &&
        log !== undefined &&
        browserLog !== undefined &&
        redactionLog !== undefined &&
        metric !== undefined &&
        auditLog !== undefined
      ) {
        return {
          exportContent: telemetryExport.content,
          root,
          redactionSpanEvent,
          child,
          log,
          browserLog,
          redactionLog,
          metric,
          auditLog,
        };
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
        const runId = yield* canaryRunId();
        const identity = yield* parseResourceIdentity({
          serviceName: "observability-canary",
          serviceVersion: "0.1.0",
          environment: "test",
        });
        const config = new TelemetryConfig({
          identity,
          otlpEndpoint: new URL("http://localhost:4318"),
        });

        yield* emitCanary(config, runId);

        const auditContract = yield* defineTelemetryContract({
          version: 1,
          events: {},
          metrics: {},
          auditActions: {
            CanaryObserved: {
              action: "canary.observed",
              resourceType: "canary",
              allowedOutcomes: ["denied"],
            },
          },
        });
        const auditConfig = yield* parseNodeObservabilityConfig({
          enabled: true,
          profile: "worker",
          service: { name: "observability-canary", version: "0.1.0", environment: "test" },
          telemetry: { endpoint: new URL("http://localhost:4318") },
          evlog: {
            contract: auditContract,
            policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
          },
          sentry: { enabled: false },
        });
        const auditAdapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1 });
        const auditObservability = yield* Effect.promise(() =>
          createNodeObservabilityFromConfig(auditConfig, [auditAdapter.registration]),
        );
        if (!auditObservability.enabled) return yield* Effect.die("audit canary runtime disabled");
        const correlationRunId = yield* parseRunId(runId);
        const auditRecord = yield* parseAuditRecord(auditContract, {
          recordId: `audit-${runId}`,
          action: "canary.observed",
          actor: { kind: "service", id: `private-${runId}@example.com` },
          resource: { id: runId },
          outcome: "denied",
          occurredAt: "2026-01-02T03:04:05.000Z",
          correlation: new CorrelationContext({
            trace: { _tag: "Untraced" },
            requestId: Option.none(),
            runId: Option.some(correlationRunId),
          }),
        });
        const committed = yield* commitAuditRecord(auditRecord, () => Effect.void).pipe(
          Effect.provide(layerNodeAuditDigest),
        );
        const auditPublisher = yield* AuditPublisher.pipe(
          Effect.provide(auditObservability.auditLayer),
        );
        const auditReceipt = yield* auditPublisher.publish(committed.record);
        assert.strictEqual(auditReceipt.kind, "published");
        yield* Effect.promise(() => auditObservability.close());

        const run = yield* findRun(runId);

        assert.strictEqual(run.root.span.name, "canary.operation");
        assert.strictEqual(run.child.span.name, "canary.child");
        assert.strictEqual(run.child.span.traceId, run.root.span.traceId);
        assert.strictEqual(run.child.span.parentSpanId, run.root.span.spanId);

        const resource = run.root.resource.attributes;
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(resource, "service.namespace")),
          "equipe-tech",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(resource, "service.name")),
          "observability-canary",
        );
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(resource, "service.version")),
          "0.1.0",
        );
        assertEnvironmentAliases(run.root.resource, "test");

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
        const auditBody = decodeAuditCanaryBody(
          JSON.parse(Option.getOrThrow(Option.fromNullishOr(run.auditLog.log.body.stringValue))),
        );
        assert.isTrue(Option.isSome(auditBody));
        const capturedAudit = Option.getOrThrow(auditBody);
        assert.strictEqual(capturedAudit["audit.record.id"], `audit-${runId}`);
        assert.strictEqual(capturedAudit["audit.outcome"], "denied");
        assert.strictEqual(capturedAudit["event.outcome"], "failure");
        assert.strictEqual(capturedAudit["run.id"], runId);
        assert.strictEqual(capturedAudit.audit.idempotencyKey, `audit-${runId}`);
        assert.strictEqual(capturedAudit.audit.actor.id, "[REDACTED]");
        assert.notInclude(run.exportContent, `private-${runId}@example.com`);

        assert.strictEqual(run.metric.metric.name, "canary.operations");
        assert.strictEqual(run.metric.dataPoint.asDouble, 1);
        assert.isAtMost(runId.length, 128);
        assert.isTrue(
          Option.isNone(attributeValue(run.metric.dataPoint.attributes, "service.instance.id")),
        );

        const sensitive = canarySensitiveValues(runId);
        for (const marker of sensitive.leakMarkers) {
          assert.notInclude(run.exportContent, marker);
        }
        for (const preservedValue of sensitive.preservedValues) {
          assert.include(run.exportContent, preservedValue);
        }

        const redactedBody = Option.getOrThrow(
          Option.fromNullishOr(run.redactionLog.log.body.stringValue),
        );
        const decodedRedactedBody = decodeRedactedLogBody(JSON.parse(redactedBody));
        for (const value of [
          decodedRedactedBody.authorization,
          decodedRedactedBody.password,
          decodedRedactedBody.token,
          decodedRedactedBody.email,
          decodedRedactedBody.accessToken,
          decodedRedactedBody.userPassword,
          decodedRedactedBody.phoneNumber,
        ]) {
          assert.strictEqual(value, "[REDACTED]");
        }
        assert.strictEqual(decodedRedactedBody.tokenizer, sensitive.tokenizerValue);
        assert.strictEqual(decodedRedactedBody.documentation, sensitive.documentationValue);

        const redactedAttributeKeys: ReadonlyArray<string> = [
          "http.authorization",
          "user.password",
          "auth.access_token",
          "profile.password",
          "contact.phone",
        ];
        const maskedAttributeSets = [
          run.root.span.attributes,
          run.redactionSpanEvent.attributes,
          run.redactionLog.log.attributes,
        ];
        for (const attributes of maskedAttributeSets) {
          for (const key of redactedAttributeKeys) {
            assert.strictEqual(Option.getOrUndefined(attributeValue(attributes, key)), "****");
          }
        }
        assert.strictEqual(
          Option.getOrUndefined(attributeValue(run.metric.dataPoint.attributes, "canary.run_id")),
          runId,
        );
        const metricAttributes = JSON.stringify(run.metric.dataPoint.attributes);
        for (const value of [
          sensitive.authorization,
          sensitive.password,
          sensitive.accessToken,
          sensitive.email,
          sensitive.phoneNumber,
        ]) {
          assert.notInclude(metricAttributes, value);
        }
        assert.include(redactedBody, "[REDACTED]");
        assert.include(run.redactionSpanEvent.name, "[REDACTED]");

        for (const signalResource of [run.log.resource, run.metric.resource]) {
          assert.strictEqual(
            Option.getOrUndefined(attributeValue(signalResource.attributes, "service.namespace")),
            "equipe-tech",
          );
          assert.strictEqual(
            Option.getOrUndefined(attributeValue(signalResource.attributes, "service.name")),
            "observability-canary",
          );
          assert.strictEqual(
            Option.getOrUndefined(attributeValue(signalResource.attributes, "service.version")),
            "0.1.0",
          );
          assertEnvironmentAliases(signalResource, "test");
        }
      }),
    60_000,
  );
});
