import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = (args: Array<string>, env = process.env): Promise<CliResult> => {
  const child = Bun.spawn(["bun", main, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
};

describe("observability CLI", () => {
  test("renders Docker Compose failures without internal paths or stack frames", async () => {
    const result = await runCli(
      ["dev", "status", "--file", "/tmp/observability-missing-compose.yml"],
      { ...process.env, NO_COLOR: "1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_COMPOSE_FAILED");
    expect(result.stderr).not.toContain("OBS_CLI_UNEXPECTED");
    expect(result.stderr).not.toContain("node_modules");
    expect(result.stderr).not.toContain(".ts:");
    expect(result.stderr).not.toContain(fileURLToPath(new URL("../../..", import.meta.url)));
    expect(result.stdout).toBe("");
  });
});
