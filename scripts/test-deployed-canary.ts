import { Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VitestReport = Schema.Struct({
  numPassedTests: Schema.Number,
});

const decodeVitestReport = Schema.decodeUnknownSync(Schema.fromJsonString(VitestReport));

export const deployedCanaryTestCount = (report: string): number =>
  decodeVitestReport(report).numPassedTests;

const run = async (): Promise<number> => {
  if (process.env.OBSERVABILITY_E2E_DEPLOYED !== "1") {
    console.error(
      "OBS_DEPLOYED_CANARY_NOT_REQUESTED: OBSERVABILITY_E2E_DEPLOYED=1 is required for the deployed canary gate.",
    );
    return 1;
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
    if (deployedCanaryTestCount(report) > 0) return 0;
    console.error(
      "OBS_DEPLOYED_CANARY_NO_TESTS: The deployed canary gate did not execute any tests.",
    );
    return 1;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
};

if (import.meta.main) process.exitCode = await run();
