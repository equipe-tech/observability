import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import {
  decodeAxiomEnvironment,
  findChildSpan,
  findLogs,
  findRootSpan,
  type AxiomEnvironment,
  type AxiomLog,
  type AxiomSpan,
} from "./support/axiom.ts";
import { canaryRunId, canarySensitiveValues, emitCanary } from "./support/canary.ts";

const deployedEnabled = process.env["OBSERVABILITY_E2E_DEPLOYED"] === "1";

type DeployedRun = {
  readonly root: AxiomSpan;
  readonly child: AxiomSpan;
  readonly completed: AxiomLog;
  readonly browser: AxiomLog;
  readonly redaction: AxiomLog;
};

const findDeployedRun = Effect.fn("findDeployedRun")(function* (
  env: AxiomEnvironment,
  runId: string,
): Effect.fn.Return<DeployedRun, never> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const root = yield* findRootSpan(env, runId);
    if (Option.isSome(root)) {
      const child = yield* findChildSpan(env, root.value.traceId);
      const logs = yield* findLogs(env, runId);
      const completed = logs.find((log) => log.eventName === "canary.completed");
      const browser = logs.find((log) => log.eventName === "canary.browser");
      const redaction = logs.find((log) => log.eventName === "canary.redaction");
      if (
        Option.isSome(child) &&
        completed !== undefined &&
        browser !== undefined &&
        redaction !== undefined
      ) {
        return { root: root.value, child: child.value, completed, browser, redaction };
      }
    }
    yield* Effect.sleep("3 seconds");
  }
  return yield* Effect.die(`The deployed canary run ${runId} was not found in Axiom.`);
});

describe.runIf(deployedEnabled)("deployed pipeline canary", () => {
  it.live(
    "exports correlated traces and logs through the production collector to Axiom",
    () =>
      Effect.gen(function* () {
        const axiom = yield* decodeAxiomEnvironment(process.env).pipe(Effect.orDie);
        const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318";
        const runId = canaryRunId();
        const config = new TelemetryConfig({
          serviceName: "observability-canary",
          serviceVersion: "0.1.0",
          environment: "e2e",
          otlpEndpoint: new URL(endpoint),
        });

        yield* emitCanary(config, runId);

        const run = yield* findDeployedRun(axiom, runId);

        assert.strictEqual(run.root.name, "canary.operation");
        assert.strictEqual(run.child.name, "canary.child");
        assert.strictEqual(run.child.traceId, run.root.traceId);
        assert.deepStrictEqual(run.child.parentSpanId, Option.some(run.root.spanId));

        assert.deepStrictEqual(run.root.serviceName, Option.some("observability-canary"));
        assert.deepStrictEqual(run.root.serviceVersion, Option.some("0.1.0"));
        assert.deepStrictEqual(run.root.environment, Option.some("e2e"));

        assert.deepStrictEqual(run.completed.traceId, Option.some(run.root.traceId));
        assert.deepStrictEqual(run.completed.eventKind, Option.some("wide"));
        assert.deepStrictEqual(run.completed.serviceName, Option.some("observability-canary"));

        assert.deepStrictEqual(run.browser.eventSource, Option.some("browser"));
        assert.deepStrictEqual(run.browser.eventKind, Option.some("wide"));

        const sensitive = canarySensitiveValues(runId);
        const redactedValues = [
          sensitive.authorization,
          sensitive.password,
          sensitive.token,
          sensitive.email,
        ];
        const redactedRecords = [
          Option.getOrThrow(run.root.events),
          Option.getOrThrow(run.redaction.body),
          Option.getOrThrow(run.redaction.authorization),
          Option.getOrThrow(run.redaction.password),
          Option.getOrThrow(run.redaction.safeMessage),
        ];
        for (const record of redactedRecords) {
          for (const value of redactedValues) {
            assert.notInclude(record, value);
          }
        }
        assert.include(Option.getOrThrow(run.root.events), "[REDACTED]");
        assert.include(Option.getOrThrow(run.redaction.body), "[REDACTED]");
      }),
    240_000,
  );
});
