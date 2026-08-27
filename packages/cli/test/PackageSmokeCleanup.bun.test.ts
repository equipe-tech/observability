import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const signals: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM"];

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`The cleanup harness did not create ${path}.`);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const waitForAbsence = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await pathExists(path))) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`The cleanup harness left ${path}.`);
};

describe("package smoke cleanup", () => {
  for (const signal of signals) {
    test(`removes its temporary directory after ${signal}`, async () => {
      const controlRoot = await mkdtemp(join(tmpdir(), "package-smoke-cleanup-test-"));
      const readyFile = join(controlRoot, "ready.txt");
      const child = Bun.spawn(
        ["bun", "scripts/package-smoke.ts", "--signal-cleanup-test", readyFile],
        {
          cwd: projectRoot,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let temporaryDirectory = "";
      let exited = false;
      try {
        await waitForFile(readyFile);
        temporaryDirectory = (await Bun.file(readyFile).text()).trim();
        expect(temporaryDirectory).toContain("observability-package-");
        expect(await pathExists(temporaryDirectory)).toBe(true);
        child.kill(signal);
        const exitCode = await child.exited;
        exited = true;
        expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
        await waitForAbsence(temporaryDirectory);
      } finally {
        if (!exited) {
          child.kill("SIGKILL");
          await child.exited;
        }
        if (temporaryDirectory !== "") {
          await rm(temporaryDirectory, { recursive: true, force: true });
        }
        await rm(controlRoot, { recursive: true, force: true });
      }
    });
  }
});
