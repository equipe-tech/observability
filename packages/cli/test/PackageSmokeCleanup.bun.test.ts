import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));

const CleanupReady = Schema.Struct({
  phase: Schema.NonEmptyString,
  temporaryDirectory: Schema.NonEmptyString.pipe(Schema.optionalKey),
  commandPid: Schema.Int.pipe(Schema.optionalKey),
  descendantPid: Schema.Int.pipe(Schema.optionalKey),
});
const SignalConfirmation = Schema.Struct({
  count: Schema.Int,
  signal: Schema.Literals(["SIGINT", "SIGTERM"]),
});

const decodeCleanupReady = Schema.decodeUnknownSync(CleanupReady);
const decodeSignalConfirmation = Schema.decodeUnknownSync(SignalConfirmation);
type CleanupSignal = "SIGINT" | "SIGTERM";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`The cleanup harness did not create ${path}.`);
};

const waitForAbsence = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await pathExists(path))) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`The cleanup harness left ${path}.`);
};

const waitForSignalConfirmation = async (
  path: string,
  count: number,
  signal: CleanupSignal,
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  let latest = "";
  while (Date.now() < deadline) {
    try {
      latest = await Bun.file(path).text();
      const confirmation = decodeSignalConfirmation(JSON.parse(latest));
      if (confirmation.count === count && confirmation.signal === signal) {
        return;
      }
    } catch {
      latest = "";
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `The cleanup harness did not confirm ${signal} as signal ${count}: ${latest.trim()}`,
  );
};

const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidAbsence = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`The cleanup harness left process ${pid}.`);
};

interface SignalScenario {
  readonly scenario: string;
  readonly signals: ReadonlyArray<CleanupSignal>;
  readonly cleanupDeadlineMilliseconds?: number;
}

const runSignalScenario = async (options: SignalScenario): Promise<number> => {
  const controlRoot = await mkdtemp(join(tmpdir(), "package-smoke-cleanup-test-"));
  const readyFile = join(controlRoot, "ready.json");
  const confirmationFile = join(controlRoot, "signal.json");
  const cleanupDeadline = options.cleanupDeadlineMilliseconds ?? 3_000;
  const child = Bun.spawn(
    [
      "bun",
      "scripts/package-smoke.ts",
      "--signal-cleanup-test",
      readyFile,
      options.scenario,
      String(cleanupDeadline),
      confirmationFile,
    ],
    {
      cwd: projectRoot,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let temporaryDirectory = "";
  let commandPid = 0;
  let descendantPid = 0;
  let exited = false;
  try {
    await waitForFile(readyFile);
    const content: unknown = JSON.parse(await Bun.file(readyFile).text());
    const ready = decodeCleanupReady(content);
    temporaryDirectory = ready.temporaryDirectory ?? "";
    commandPid = ready.commandPid ?? 0;
    descendantPid = ready.descendantPid ?? 0;
    if (temporaryDirectory !== "") {
      expect(await pathExists(temporaryDirectory)).toBe(true);
    }
    const startedAt = Date.now();
    for (const [index, signal] of options.signals.entries()) {
      child.kill(signal);
      await waitForSignalConfirmation(confirmationFile, index + 1, signal);
    }
    const exitCode = await child.exited;
    exited = true;
    const elapsed = Date.now() - startedAt;
    expect(exitCode).toBe(options.signals[0] === "SIGINT" ? 130 : 143);
    if (temporaryDirectory !== "") {
      await waitForAbsence(temporaryDirectory);
    }
    if (commandPid !== 0) {
      await waitForPidAbsence(commandPid);
    }
    if (descendantPid !== 0) {
      await waitForPidAbsence(descendantPid);
    }
    return elapsed;
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (commandPid !== 0 && pidExists(commandPid)) {
      process.kill(commandPid, "SIGKILL");
    }
    if (descendantPid !== 0 && pidExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    await rm(controlRoot, { recursive: true, force: true });
  }
};

describe("package smoke cleanup", () => {
  test("joins cleanup when signaled during allocation", async () => {
    await runSignalScenario({ scenario: "allocation", signals: ["SIGINT"] });
  });

  test("terminates an active command process tree", async () => {
    await runSignalScenario({ scenario: "active", signals: ["SIGTERM"] });
  });

  test("joins repeated identical signals", async () => {
    await runSignalScenario({ scenario: "allocation", signals: ["SIGINT", "SIGINT"] });
  });

  test("joins mixed signals and preserves the first exit code", async () => {
    await runSignalScenario({ scenario: "allocation", signals: ["SIGTERM", "SIGINT"] });
  });

  test("bounds SIGTERM, SIGKILL, and exit observation by one deadline", async () => {
    const elapsed = await runSignalScenario({
      scenario: "deadline",
      signals: ["SIGTERM"],
      cleanupDeadlineMilliseconds: 400,
    });
    expect(elapsed).toBeLessThan(1_500);
  });

  test("cleans a normal failure", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "package-smoke-failure-test-"));
    const readyFile = join(controlRoot, "ready.json");
    const child = Bun.spawn(
      ["bun", "scripts/package-smoke.ts", "--signal-cleanup-test", readyFile, "failure"],
      { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
    );
    let temporaryDirectory = "";
    try {
      await waitForFile(readyFile);
      const content: unknown = JSON.parse(await Bun.file(readyFile).text());
      temporaryDirectory = decodeCleanupReady(content).temporaryDirectory ?? "";
      expect(await child.exited).toBe(1);
      await waitForAbsence(temporaryDirectory);
    } finally {
      child.kill("SIGKILL");
      if (temporaryDirectory !== "") {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      await rm(controlRoot, { recursive: true, force: true });
    }
  });
});
