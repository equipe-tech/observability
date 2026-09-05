import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = join(projectRoot, "packages/telemetry/test/fixtures/otlp-capture-lifecycle.ts");
let temporaryDirectory = "";
let bundle = "";

type ChildResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

const runCaptureLifecycle = async (host: string): Promise<ChildResult> => {
  const child = Bun.spawn(["node", bundle, host], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
  const timeout = Bun.sleep(5_000).then(async () => {
    child.kill();
    await child.exited;
    throw new Error(`Capture lifecycle child did not exit for host ${host}.`);
  });
  return Promise.race([completed, timeout]);
};

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "otlp-capture-lifecycle-"));
  bundle = join(temporaryDirectory, "fixture.mjs");
  const build = Bun.spawn(["bun", "build", fixture, "--target=node", `--outfile=${bundle}`], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("OTLP capture server lifecycle", () => {
  test("acquires and stops an IPv6 listener without retaining the child process", async () => {
    const result = await runCaptureLifecycle("::1");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("acquired http://[::1]:");
    expect(result.stdout).toContain("stopped");
  });

  test("rejects an unavailable host without an uncaught error or retained child", async () => {
    const result = await runCaptureLifecycle("192.0.2.1");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("rejected Error: listen EADDRNOTAVAIL");
  });
});
