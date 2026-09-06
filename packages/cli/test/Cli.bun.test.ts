import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
  test("uses environment tokens through existing provider and credential owners", async () => {
    const home = await mkdtemp(join(tmpdir(), "observability-auth-success-"));
    directories.push(home);
    let authorization = "";
    let organization = "";
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        authorization = request.headers.get("authorization") ?? "";
        organization = request.headers.get("x-axiom-org-id") ?? "";
        return Response.json({ id: "fixture-user", email: "owner@example.com" });
      },
    });
    try {
      const result = await runCli(
        [
          "auth",
          "login",
          "axiom",
          "--organization-id",
          "fixture-org",
          "--token-env",
          "TEST_AXIOM_TOKEN",
        ],
        {
          ...process.env,
          NODE_ENV: "test",
          OBSERVABILITY_HOME: home,
          OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: `http://127.0.0.1:${server.port}`,
          TEST_AXIOM_TOKEN: "private-token",
        },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "Authenticated with Axiom as owner@example.com.\n",
        stderr: "",
      });
      expect(authorization).toBe("Bearer private-token");
      expect(organization).toBe("fixture-org");
      const credentialsPath = join(home, "credentials.json");
      expect(await readFile(credentialsPath, "utf8")).toContain("private-token");
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
      expect(`${result.stdout}${result.stderr}`).not.toContain("private-token");
    } finally {
      await server.stop(true);
    }
  });

  test("rejects environment token failures before provider access or credential writes", async () => {
    for (const testCase of [
      { name: "MISSING_AUTH_TOKEN", value: undefined },
      { name: "EMPTY_AUTH_TOKEN", value: "" },
      { name: "INVALID_AUTH_TOKEN", value: "private-token\nsecond-line" },
      { name: "invalid-name", value: "private-token" },
    ]) {
      const home = await mkdtemp(join(tmpdir(), "observability-auth-input-"));
      directories.push(home);
      await rm(home, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, OBSERVABILITY_HOME: home };
      if (testCase.value === undefined) delete env[testCase.name];
      else env[testCase.name] = testCase.value;
      const result = await runCli(
        [
          "auth",
          "login",
          "axiom",
          "--organization-id",
          "fixture-org",
          "--token-env",
          testCase.name,
        ],
        env,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("OBS_CLI_AUTH_TOKEN_INPUT_INVALID");
      expect(result.stderr).not.toContain("private-token");
      expect(result.stdout).toBe("");
      expect(Bun.file(join(home, "credentials.json")).exists()).resolves.toBe(false);
    }
  });

  test("removes pipeline from setup help and exposes release declarations", async () => {
    const result = await runCli(["setup", "plan", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("--pipeline");
    expect(result.stdout).toContain("--source-map-build-script");
    expect(result.stdout).toContain("--source-map-path");
    expect(result.stdout).toContain("--axiom-organization-id");
  });

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
