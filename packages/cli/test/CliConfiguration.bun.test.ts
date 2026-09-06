import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (
  args: ReadonlyArray<string>,
  home: string,
  timeout: string,
): Promise<CommandResult> => {
  const processHandle = Bun.spawn(["bun", "packages/cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OBSERVABILITY_HOME: home,
      OBSERVABILITY_CLI_REQUEST_TIMEOUT_MILLISECONDS: timeout,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
};

describe("CLI request timeout configuration", () => {
  test("reports the fixed timeout error for every command group", async () => {
    const home = await mkdtemp(join(tmpdir(), "observability-cli-configuration-"));
    try {
      for (const args of [
        ["env", "list"],
        ["auth", "status"],
        ["dev", "status"],
        ["ops", "plan"],
      ]) {
        for (const timeout of ["", "abc", "10.5", "99", "120001"]) {
          const result = await runCli(args, home, timeout);
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe(
            "OBS_CLI_REMOTE_FAILED: The provider request timeout configuration is invalid.\n",
          );
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
