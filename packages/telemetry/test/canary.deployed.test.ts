import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { parseResourceIdentity } from "../src/ResourceIdentity.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import {
  decodeAxiomEnvironment,
  findChildSpan,
  findLogs,
  findMetric,
  findRootSpan,
  type AxiomEnvironment,
  type AxiomLog,
  type AxiomMetric,
  type AxiomRedactionAttributes,
  type AxiomSpan,
} from "./support/axiom.ts";
import {
  canaryRunId,
  canarySensitiveValues,
  canaryServiceVersion,
  emitCanary,
} from "./support/canary.ts";

const deployedEnabled = process.env["OBSERVABILITY_E2E_DEPLOYED"] === "1";
const canaryEnvironment = "e2e";

type DeployedCanaryResponses = {
  root: string;
  child: string;
  logs: string;
  metric: string;
};

type DeployedRun = {
  readonly root: AxiomSpan;
  readonly child: AxiomSpan;
  readonly completed: AxiomLog;
  readonly browser: AxiomLog;
  readonly redaction: AxiomLog;
  readonly metric: AxiomMetric;
};

const findDeployedRun = Effect.fn("findDeployedRun")(function* (
  env: AxiomEnvironment,
  runId: string,
): Effect.fn.Return<DeployedRun, never> {
  const responses: DeployedCanaryResponses = {
    root: "not queried",
    child: "not queried",
    logs: "not queried",
    metric: "not queried",
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    const root = yield* findRootSpan(env, runId, canaryServiceVersion, (response) => {
      responses.root = response;
    });
    if (Option.isSome(root)) {
      const child = yield* findChildSpan(env, root.value.traceId, (response) => {
        responses.child = response;
      });
      const logs = yield* findLogs(env, runId, canaryServiceVersion, (response) => {
        responses.logs = response;
      });
      const metric = yield* findMetric(
        env,
        runId,
        canaryEnvironment,
        "observability-canary",
        canaryServiceVersion,
        (response) => {
          responses.metric = response;
        },
      );
      const completed = logs.find((log) => log.eventName === "canary.completed");
      const browser = logs.find((log) => log.eventName === "canary.browser");
      const redaction = logs.find((log) => log.eventName === "canary.redaction");
      if (
        Option.isSome(child) &&
        completed !== undefined &&
        browser !== undefined &&
        redaction !== undefined &&
        Option.isSome(metric)
      ) {
        yield* Effect.logInfo(
          `Axiom trace query matched run_id=${runId} trace_id=${root.value.traceId} span_id=${root.value.spanId} service_version=${canaryServiceVersion}`,
        );
        yield* Effect.logInfo(
          `Axiom log query matched run_id=${runId} trace_id=${Option.getOrElse(completed.traceId, () => "none")} service_version=${canaryServiceVersion}`,
        );
        yield* Effect.logInfo(
          `Axiom metric query matched run_id=${runId} service_version=${canaryServiceVersion}`,
        );
        return {
          root: root.value,
          child: child.value,
          completed,
          browser,
          redaction,
          metric: metric.value,
        };
      }
    }
    yield* Effect.sleep("3 seconds");
  }
  return yield* Effect.die(
    `The deployed canary run ${runId} for service version ${canaryServiceVersion} was not found in Axiom after 60 attempts. Last provider responses: ${JSON.stringify(responses)}.`,
  );
});

const redactionAttributeValues = (attributes: AxiomRedactionAttributes): ReadonlyArray<string> => [
  Option.getOrThrow(attributes.authorization),
  Option.getOrThrow(attributes.password),
  Option.getOrThrow(attributes.accessToken),
  Option.getOrThrow(attributes.userPassword),
  Option.getOrThrow(attributes.phoneNumber),
  Option.getOrThrow(attributes.safeMessage),
];

const assertEnvironmentAliases = (
  environmentName: Option.Option<string>,
  environmentAlias: Option.Option<string>,
  expected: string,
): void => {
  assert.deepStrictEqual(environmentName, Option.some(expected));
  assert.deepStrictEqual(environmentAlias, environmentName);
};

const assertRedactionAttributes = (
  attributes: AxiomRedactionAttributes,
  sensitive: ReturnType<typeof canarySensitiveValues>,
): void => {
  for (const value of [
    attributes.authorization,
    attributes.password,
    attributes.accessToken,
    attributes.userPassword,
    attributes.phoneNumber,
  ]) {
    assert.deepStrictEqual(value, Option.some("****"));
  }
  assert.deepStrictEqual(attributes.tokenizer, Option.some(sensitive.tokenizerValue));
  assert.deepStrictEqual(attributes.documentation, Option.some(sensitive.documentationValue));
  assert.include(Option.getOrThrow(attributes.safeMessage), "****");
};

describe.runIf(deployedEnabled)("deployed pipeline canary", () => {
  it.live(
    "exports redacted traces, logs and metrics through the production collector to Axiom",
    () =>
      Effect.gen(function* () {
        const axiom = yield* decodeAxiomEnvironment(process.env).pipe(Effect.orDie);
        const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318";
        const runId = yield* canaryRunId();
        const identity = yield* parseResourceIdentity({
          serviceName: "observability-canary",
          serviceVersion: canaryServiceVersion,
          environment: canaryEnvironment,
        });
        const config = new TelemetryConfig({
          identity,
          otlpEndpoint: new URL(endpoint),
        });

        yield* emitCanary(config, runId);

        const run = yield* findDeployedRun(axiom, runId);

        assert.strictEqual(run.root.name, "canary.operation");
        assert.strictEqual(run.child.name, "canary.child");
        assert.strictEqual(run.child.traceId, run.root.traceId);
        assert.deepStrictEqual(run.child.parentSpanId, Option.some(run.root.spanId));

        assert.deepStrictEqual(run.root.serviceNamespace, Option.some("equipe-tech"));
        assert.deepStrictEqual(run.root.serviceName, Option.some("observability-canary"));
        assert.deepStrictEqual(run.root.serviceVersion, Option.some(canaryServiceVersion));
        assert.isTrue(Option.isNone(run.root.serviceInstanceId));
        assertEnvironmentAliases(
          run.root.environmentName,
          run.root.environmentAlias,
          canaryEnvironment,
        );

        assert.deepStrictEqual(run.completed.traceId, Option.some(run.root.traceId));
        assert.deepStrictEqual(run.completed.eventKind, Option.some("wide"));
        assert.deepStrictEqual(run.completed.serviceNamespace, Option.some("equipe-tech"));
        assert.deepStrictEqual(run.completed.serviceName, Option.some("observability-canary"));
        assert.isTrue(Option.isNone(run.completed.serviceInstanceId));
        assertEnvironmentAliases(
          run.completed.environmentName,
          run.completed.environmentAlias,
          canaryEnvironment,
        );

        assert.deepStrictEqual(run.browser.eventSource, Option.some("browser"));
        assert.deepStrictEqual(run.browser.eventKind, Option.some("wide"));

        assert.isAtMost(runId.length, 128);
        assert.notInclude(run.metric.content, "service.instance.id");

        const sensitive = canarySensitiveValues(runId);
        assertRedactionAttributes(run.root.redaction, sensitive);
        assertRedactionAttributes(run.redaction.redaction, sensitive);

        const rootEvents = Option.getOrThrow(run.root.events);
        const redactedBody = Option.getOrThrow(run.redaction.body);
        const exportedContent = [
          rootEvents,
          redactedBody,
          run.metric.content,
          ...redactionAttributeValues(run.root.redaction),
          ...redactionAttributeValues(run.redaction.redaction),
        ];
        for (const content of exportedContent) {
          for (const marker of sensitive.leakMarkers) {
            assert.notInclude(content, marker);
          }
        }
        for (const preservedValue of sensitive.preservedValues) {
          assert.include(run.metric.content, preservedValue);
        }
        assert.include(run.metric.content, "****");
        assert.include(rootEvents, "[REDACTED]");
        assert.include(redactedBody, "[REDACTED]");
      }),
    240_000,
  );
});
