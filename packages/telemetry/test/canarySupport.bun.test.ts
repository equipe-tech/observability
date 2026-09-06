import { expect, test } from "bun:test";
import { Schema } from "effect";
import { join } from "node:path";

const projectRoot = join(import.meta.dirname, "../../..");
const TelemetryManifest = Schema.Struct({ version: Schema.NonEmptyString });
const telemetryManifest = Schema.decodeUnknownSync(TelemetryManifest)(
  await Bun.file(join(projectRoot, "packages/telemetry/package.json")).json(),
);

test("falls back to the package version when OTEL_SERVICE_VERSION is empty", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { canaryServiceVersion } from "./packages/telemetry/test/support/canary.ts"; console.log(canaryServiceVersion);',
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, OTEL_SERVICE_VERSION: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.trim()).toBe(telemetryManifest.version);
});
