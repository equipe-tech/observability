import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyNpmView } from "../../../scripts/npm-publication-state.ts";

const projectRoot = join(import.meta.dirname, "../../..");
let fakeBin = "";

interface ScriptResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const executePublicationState = async (
  args: ReadonlyArray<string>,
  mode: string,
): Promise<ScriptResult> => {
  const child = Bun.spawn(["bun", "scripts/npm-publication-state.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FAKE_NPM_MODE: mode,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

beforeAll(async () => {
  fakeBin = await mkdtemp(join(tmpdir(), "npm-publication-state-test-"));
  const executable = join(fakeBin, "npm");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
const mode = process.env["FAKE_NPM_MODE"];
if (mode === "published") {
  process.stdout.write('"1.2.3"\\n');
  process.exit(0);
}
if (mode === "missing") {
  process.stderr.write("npm error code E404\\n");
  process.exit(1);
}
if (mode === "authentication") {
  process.stderr.write("npm error code E401\\n");
  process.exit(1);
}
process.stderr.write("npm error code ENETUNREACH\\n");
process.exit(1);
`,
  );
  await chmod(executable, 0o755);
});

afterAll(async () => {
  await rm(fakeBin, { recursive: true, force: true });
});

describe("npm publication state classifier", () => {
  test("classifies an existing version as published", () => {
    expect(classifyNpmView({ exitCode: 0, stdout: '"0.3.0"', stderr: "" })).toBe("published");
  });

  test("classifies only npm not-found responses as missing", () => {
    expect(classifyNpmView({ exitCode: 1, stdout: "", stderr: "npm error code E404" })).toBe(
      "missing",
    );
  });

  test.each([
    ["network", "npm error code ENETUNREACH"],
    ["authentication", "npm error code E401"],
    ["authorization", "npm error code E403"],
  ])("rejects %s failures", (_name, stderr) => {
    expect(() => classifyNpmView({ exitCode: 1, stdout: "", stderr })).toThrow(
      "npm view failed with exit code 1",
    );
  });
});

describe("npm publication state executable", () => {
  test("prints published for an existing package version", async () => {
    const result = await executePublicationState(["@scope/package", "1.2.3"], "published");
    expect(result).toEqual({ exitCode: 0, stdout: "published\n", stderr: "" });
  });

  test("prints missing for an E404 response", async () => {
    const result = await executePublicationState(["@scope/package", "1.2.3"], "missing");
    expect(result).toEqual({ exitCode: 0, stdout: "missing\n", stderr: "" });
  });

  test.each(["authentication", "network"])("rejects an npm %s failure", async (mode) => {
    const result = await executePublicationState(["@scope/package", "1.2.3"], mode);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("npm view failed with exit code 1");
    expect(result.stderr).toContain(mode === "authentication" ? "E401" : "ENETUNREACH");
  });

  test("rejects no arguments with usage", async () => {
    const result = await executePublicationState([], "published");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Usage: bun scripts/npm-publication-state.ts <package> <version>",
    );
  });

  test("rejects a missing version with usage", async () => {
    const result = await executePublicationState(["@scope/package"], "published");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Usage: bun scripts/npm-publication-state.ts <package> <version>",
    );
  });
});
