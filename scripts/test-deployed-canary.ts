import { Effect, Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VitestReport = Schema.Struct({
  numPassedTests: Schema.Number,
});

const decodeVitestReport = Schema.decodeUnknownEffect(Schema.fromJsonString(VitestReport));

const DeployedCanaryErrorCode = Schema.Literals([
  "OBS_DEPLOYED_CANARY_NOT_REQUESTED",
  "OBS_DEPLOYED_CANARY_NO_TESTS",
  "OBS_DEPLOYED_CANARY_REPORT_INVALID",
  "OBS_DEPLOYED_CANARY_UNEXPECTED",
]);

export class DeployedCanaryError extends Schema.TaggedError<DeployedCanaryError>()(
  "DeployedCanaryError",
  {
    code: DeployedCanaryErrorCode,
    message: Schema.String,
    correlationId: Schema.NonEmptyString,
    cause: Schema.Defect(),
  },
) {}

const deployedCanaryError = (
  code: typeof DeployedCanaryErrorCode.Type,
  message: string,
  correlationId: string,
  cause: unknown,
): DeployedCanaryError =>
  new DeployedCanaryError({
    code,
    message: `${message} Correlation ID: ${correlationId}.`,
    correlationId,
    cause,
  });

const unexpectedDeployedCanaryError = (
  correlationId: string,
  cause: unknown,
): DeployedCanaryError =>
  deployedCanaryError(
    "OBS_DEPLOYED_CANARY_UNEXPECTED",
    "The deployed canary command failed unexpectedly.",
    correlationId,
    cause,
  );

export const deployedCanaryTestCount = Effect.fn("deployedCanaryTestCount")(function* (
  report: string,
  correlationId: string = crypto.randomUUID(),
) {
  return yield* decodeVitestReport(report).pipe(
    Effect.mapError((cause) =>
      deployedCanaryError(
        "OBS_DEPLOYED_CANARY_REPORT_INVALID",
        "The deployed canary test report is malformed.",
        correlationId,
        cause,
      ),
    ),
    Effect.map((decoded) => decoded.numPassedTests),
  );
});

export const requireDeployedCanaryTests = Effect.fn("requireDeployedCanaryTests")(function* (
  report: string,
  correlationId: string = crypto.randomUUID(),
) {
  const count = yield* deployedCanaryTestCount(report, correlationId);
  if (count > 0) return count;
  return yield* deployedCanaryError(
    "OBS_DEPLOYED_CANARY_NO_TESTS",
    "The deployed canary gate did not execute any tests.",
    correlationId,
    report,
  );
});

const run = Effect.fn("deployedCanary.run")(function* () {
  const correlationId = crypto.randomUUID();
  if (process.env.OBSERVABILITY_E2E_DEPLOYED !== "1") {
    return yield* deployedCanaryError(
      "OBS_DEPLOYED_CANARY_NOT_REQUESTED",
      "OBSERVABILITY_E2E_DEPLOYED=1 is required for the deployed canary gate.",
      correlationId,
      process.env.OBSERVABILITY_E2E_DEPLOYED,
    );
  }
  const outputDirectory = yield* Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "observability-deployed-canary-")),
    catch: (cause) => unexpectedDeployedCanaryError(correlationId, cause),
  });
  const reportPath = join(outputDirectory, "vitest-report.json");
  return yield* Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn(
          [
            "vp",
            "test",
            "run",
            "packages/telemetry/test/canary.deployed.test.ts",
            "--reporter=default",
            "--reporter=json",
            `--outputFile.json=${reportPath}`,
          ],
          { cwd: process.cwd(), env: process.env, stdout: "inherit", stderr: "inherit" },
        ),
      catch: (cause) => unexpectedDeployedCanaryError(correlationId, cause),
    });
    const exitCode = yield* Effect.tryPromise({
      try: () => child.exited,
      catch: (cause) => unexpectedDeployedCanaryError(correlationId, cause),
    });
    if (exitCode !== 0) return exitCode;
    const report = yield* Effect.tryPromise({
      try: () => readFile(reportPath, "utf8"),
      catch: (cause) => unexpectedDeployedCanaryError(correlationId, cause),
    });
    yield* requireDeployedCanaryTests(report, correlationId);
    return 0;
  }).pipe(
    Effect.ensuring(Effect.promise(() => rm(outputDirectory, { recursive: true, force: true }))),
  );
});

if (import.meta.main) {
  Effect.runPromise(run()).catch((cause) => {
    const error =
      cause instanceof DeployedCanaryError
        ? cause
        : unexpectedDeployedCanaryError(crypto.randomUUID(), cause);
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  });
}
