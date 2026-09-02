import { Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VitestReport = Schema.Struct({
  numPassedTests: Schema.Number,
});

const decodeVitestReport = Schema.decodeUnknownSync(Schema.fromJsonString(VitestReport));

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

export const deployedCanaryTestCount = (
  report: string,
  correlationId: string = crypto.randomUUID(),
): number => {
  try {
    return decodeVitestReport(report).numPassedTests;
  } catch (cause) {
    throw deployedCanaryError(
      "OBS_DEPLOYED_CANARY_REPORT_INVALID",
      "The deployed canary test report is malformed.",
      correlationId,
      cause,
    );
  }
};

const run = async (): Promise<number> => {
  const correlationId = crypto.randomUUID();
  if (process.env.OBSERVABILITY_E2E_DEPLOYED !== "1") {
    throw deployedCanaryError(
      "OBS_DEPLOYED_CANARY_NOT_REQUESTED",
      "OBSERVABILITY_E2E_DEPLOYED=1 is required for the deployed canary gate.",
      correlationId,
      process.env.OBSERVABILITY_E2E_DEPLOYED,
    );
  }
  const outputDirectory = await mkdtemp(join(tmpdir(), "observability-deployed-canary-"));
  const reportPath = join(outputDirectory, "vitest-report.json");
  try {
    const child = Bun.spawn(
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
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) return exitCode;
    const report = await readFile(reportPath, "utf8");
    if (deployedCanaryTestCount(report, correlationId) > 0) return 0;
    throw deployedCanaryError(
      "OBS_DEPLOYED_CANARY_NO_TESTS",
      "The deployed canary gate did not execute any tests.",
      correlationId,
      report,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await run();
  } catch (cause) {
    const error =
      cause instanceof DeployedCanaryError
        ? cause
        : deployedCanaryError(
            "OBS_DEPLOYED_CANARY_UNEXPECTED",
            "The deployed canary command failed unexpectedly.",
            crypto.randomUUID(),
            cause,
          );
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  }
}
