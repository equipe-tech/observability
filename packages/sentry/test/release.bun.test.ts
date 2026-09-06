import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sentrySourceMapUpload } from "../src/index.ts";
import { executeSentrySourceMapUpload, sentryCliSourceMapTransport } from "../src/release/index.ts";

describe("Sentry release transport", () => {
  test("uses the explicitly selected Sentry CLI executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sentry-cli-transport-"));
    try {
      const executable = join(directory, "recording-sentry-cli");
      const output = join(directory, "arguments.json");
      await writeFile(
        executable,
        `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`,
      );
      await chmod(executable, 0o700);
      const plan = sentrySourceMapUpload({
        organization: "equipe-tech",
        project: "web",
        release: "1.4.0",
        includePaths: ["dist"],
      });
      await Effect.runPromise(
        executeSentrySourceMapUpload(plan, sentryCliSourceMapTransport({ executable })),
      );
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(plan.args);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
