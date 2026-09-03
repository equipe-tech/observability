import { expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployedCanaryTestCount,
  DeployedCanaryError,
  requireDeployedCanaryTests,
} from "../scripts/test-deployed-canary.ts";
import {
  ReleaseCanaryError,
  ReleaseCanaryIdentity,
  requireReleaseCanaryCredential,
  resolveReleaseCanaryIdentity,
} from "../scripts/release-canary.ts";

interface CommandRequest {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ReleaseRepository {
  readonly root: string;
  readonly runRelease: (args: ReadonlyArray<string>) => Promise<CommandResult>;
}

const projectRoot = join(import.meta.dirname, "..");
const releaseScript = await Bun.file(join(projectRoot, "scripts/release.ts")).text();
const releaseCanaryScript = await Bun.file(join(projectRoot, "scripts/release-canary.ts")).text();

const execute = async (request: CommandRequest): Promise<CommandResult> => {
  const child = Bun.spawn([...request.command], {
    cwd: request.cwd,
    env: request.env,
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

const runGit = async (root: string, args: ReadonlyArray<string>): Promise<string> => {
  const result = await execute({ command: ["git", ...args], cwd: root, env: process.env });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

const manifest = (name: string, version: string): string =>
  `${JSON.stringify({ name, version }, undefined, 2)}\n`;

const withReleaseRepository = async (
  use: (repository: ReleaseRepository) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "release-test-"));
  const fakeBin = join(root, ".bin");
  const releaseEnvironment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "packages", "alpha"), { recursive: true });
    await mkdir(join(root, "packages", "beta"), { recursive: true });
    await mkdir(fakeBin);
    await writeFile(join(root, ".gitignore"), ".bin\nnode_modules\n");
    await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"));
    await writeFile(join(root, "scripts", "release.ts"), releaseScript);
    await writeFile(
      join(root, "packages", "alpha", "package.json"),
      manifest("@equipe-tech/alpha", "1.2.3"),
    );
    await writeFile(
      join(root, "packages", "beta", "package.json"),
      manifest("@equipe-tech/beta", "4.5.6"),
    );
    await writeFile(join(root, "bun.lock"), "lockfile\n");
    await writeFile(join(fakeBin, "bun"), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, "bun"), 0o755);
    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["config", "user.name", "Release Test"]);
    await runGit(root, ["config", "user.email", "release-test@example.com"]);
    await runGit(root, ["add", "."]);
    await runGit(root, ["commit", "--quiet", "-m", "test: baseline"]);
    await use({
      root,
      runRelease: (args) =>
        execute({
          command: [process.execPath, "scripts/release.ts", ...args],
          cwd: root,
          env: releaseEnvironment,
        }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const withReleaseCanaryRepository = async (
  manifestContent: string | undefined,
  use: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "release-canary-test-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"));
    await writeFile(join(root, "scripts", "release-canary.ts"), releaseCanaryScript);
    if (manifestContent !== undefined) {
      await mkdir(join(root, "packages", "alpha"), { recursive: true });
      await writeFile(join(root, "packages", "alpha", "package.json"), manifestContent);
    }
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runReleaseCanary = (
  root: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> =>
  execute({ command: [process.execPath, "scripts/release-canary.ts", ...args], cwd: root, env });

const expectSanitizedReleaseCanaryFailure = (
  result: CommandResult,
  root: string,
  code: string,
): void => {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith(`${code}: `);
  expect(result.stderr).not.toContain(root);
  expect(result.stderr).not.toContain(" at ");
};

test("derives one release canary identity from the matching package manifest", async () => {
  await withReleaseRepository(async ({ root }) => {
    const identity = await Effect.runPromise(resolveReleaseCanaryIdentity(root, "alpha@1.2.3"));
    expect(identity).toEqual(
      new ReleaseCanaryIdentity({
        releaseTag: "alpha@1.2.3",
        packageName: "@equipe-tech/alpha",
        packageSlug: "alpha",
        packageVersion: "1.2.3",
        otelServiceVersion: "1.2.3",
      }),
    );
  });
});

test("accepts each scoped release canary credential independently", async () => {
  await Effect.runPromise(
    requireReleaseCanaryCredential({ AXIOM_INGEST_TOKEN: "ingest-secret" }, "AXIOM_INGEST_TOKEN"),
  );
  await Effect.runPromise(
    requireReleaseCanaryCredential({ AXIOM_READ_TOKEN: "read-secret" }, "AXIOM_READ_TOKEN"),
  );
});

test("rejects a missing release canary credential with a correlated error", async () => {
  const error = await Effect.runPromise(
    Effect.flip(requireReleaseCanaryCredential({}, "AXIOM_READ_TOKEN", "test-correlation")),
  );
  expect(error).toBeInstanceOf(ReleaseCanaryError);
  expect(error.code).toBe("OBS_RELEASE_CANARY_CREDENTIALS_MISSING");
  expect(error.correlationId).toBe("test-correlation");
  expect(error.message).toContain("Correlation ID: test-correlation.");
});

test("writes release metadata from the matching manifest", async () => {
  await withReleaseCanaryRepository(manifest("@equipe-tech/alpha", "1.2.3"), async (root) => {
    const output = join(root, "github-output");
    const result = await runReleaseCanary(root, [
      "--tag",
      "alpha@1.2.3",
      "--github-output",
      output,
    ]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "tag=alpha@1.2.3\narchive=equipe-tech-alpha-1.2.3.tgz\nprerelease=false\nnpm_tag=latest\n",
    );
  });
});

test("selects the rc npm tag from a prerelease package version", async () => {
  await withReleaseCanaryRepository(manifest("@equipe-tech/alpha", "1.2.3-rc.4"), async (root) => {
    const output = join(root, "github-output");
    const result = await runReleaseCanary(root, [
      "--tag",
      "alpha@1.2.3-rc.4",
      "--github-output",
      output,
    ]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "tag=alpha@1.2.3-rc.4\narchive=equipe-tech-alpha-1.2.3-rc.4.tgz\nprerelease=true\nnpm_tag=rc\n",
    );
  });
});

test("sanitizes a release tag version mismatch", async () => {
  await withReleaseCanaryRepository(manifest("@equipe-tech/alpha", "1.2.3"), async (root) => {
    const result = await runReleaseCanary(root, [
      "--tag",
      "alpha@9.9.9",
      "--github-output",
      join(root, "output"),
    ]);
    expectSanitizedReleaseCanaryFailure(result, root, "OBS_RELEASE_CANARY_VERSION_MISMATCH");
  });
});

test("sanitizes a missing package manifest", async () => {
  await withReleaseCanaryRepository(undefined, async (root) => {
    const result = await runReleaseCanary(root, [
      "--tag",
      "alpha@1.2.3",
      "--github-output",
      join(root, "output"),
    ]);
    expectSanitizedReleaseCanaryFailure(result, root, "OBS_RELEASE_CANARY_PACKAGE_UNKNOWN");
  });
});

test("sanitizes a malformed release tag", async () => {
  await withReleaseCanaryRepository(manifest("@equipe-tech/alpha", "1.2.3"), async (root) => {
    const result = await runReleaseCanary(root, [
      "--tag",
      "not-a-tag",
      "--github-output",
      join(root, "output"),
    ]);
    expectSanitizedReleaseCanaryFailure(result, root, "OBS_RELEASE_CANARY_TAG_INVALID");
  });
});

test("sanitizes a malformed package manifest", async () => {
  await withReleaseCanaryRepository("{", async (root) => {
    const result = await runReleaseCanary(root, [
      "--tag",
      "alpha@1.2.3",
      "--github-output",
      join(root, "output"),
    ]);
    expectSanitizedReleaseCanaryFailure(result, root, "OBS_RELEASE_CANARY_MANIFEST_INVALID");
  });
});

test("sanitizes missing release canary arguments", async () => {
  await withReleaseCanaryRepository(undefined, async (root) => {
    const result = await runReleaseCanary(root, []);
    expectSanitizedReleaseCanaryFailure(result, root, "OBS_RELEASE_CANARY_ARGUMENTS_INVALID");
  });
});

test("requires an explicit deployed canary request", async () => {
  const result = await execute({
    command: [process.execPath, "run", "test:canary:deployed"],
    cwd: projectRoot,
    env: { ...process.env, OBSERVABILITY_E2E_DEPLOYED: "" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "OBS_DEPLOYED_CANARY_NOT_REQUESTED: OBSERVABILITY_E2E_DEPLOYED=1 is required for the deployed canary gate.",
  );
});

test("rejects a zero-test report through the deployed canary entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployed-canary-entrypoint-test-"));
  const fakeBin = join(root, "bin");
  const fakeVp = join(fakeBin, "vp");
  try {
    await mkdir(fakeBin);
    await writeFile(
      fakeVp,
      [
        "#!/bin/sh",
        'for argument in "$@"; do',
        '  case "$argument" in',
        '    --outputFile.json=*) report="${argument#*=}" ;;',
        "  esac",
        "done",
        `printf '{"numPassedTests":0}\\n' > "$report"`,
      ].join("\n"),
    );
    await chmod(fakeVp, 0o755);
    const result = await execute({
      command: [process.execPath, "scripts/test-deployed-canary.ts"],
      cwd: projectRoot,
      env: {
        ...process.env,
        OBSERVABILITY_E2E_DEPLOYED: "1",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("OBS_DEPLOYED_CANARY_NO_TESTS:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when the deployed canary runner exits nonzero", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployed-canary-suite-failure-test-"));
  const fallbackRunner = join(root, "vp");
  try {
    await writeFile(fallbackRunner, "#!/bin/sh\nexit 99\n");
    await chmod(fallbackRunner, 0o755);
    for (const childExitCode of [1, 42]) {
      const runner = join(root, `runner-${childExitCode}`);
      await writeFile(runner, `#!/bin/sh\nexit ${childExitCode}\n`);
      await chmod(runner, 0o755);
      const result = await execute({
        command: [process.execPath, "scripts/test-deployed-canary.ts"],
        cwd: projectRoot,
        env: {
          ...process.env,
          OBSERVABILITY_E2E_DEPLOYED: "1",
          OBSERVABILITY_DEPLOYED_CANARY_RUNNER: runner,
          PATH: root,
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("OBS_DEPLOYED_CANARY_SUITE_FAILED:");
      expect(result.stderr).toContain(`exit code ${childExitCode}`);
      expect(result.stderr).toContain("vitest-report.json");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads the executed test count from the deployed canary report", () => {
  expect(Effect.runSync(deployedCanaryTestCount('{"numPassedTests":1}'))).toBe(1);
  expect(Effect.runSync(deployedCanaryTestCount('{"numPassedTests":0}'))).toBe(0);
});

test("types and sanitizes a deployed canary report with no tests", () => {
  const error = Effect.runSync(
    requireDeployedCanaryTests('{"numPassedTests":0}', "test-empty").pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(DeployedCanaryError);
  expect(error.code).toBe("OBS_DEPLOYED_CANARY_NO_TESTS");
  expect(error.correlationId).toBe("test-empty");
  expect(error.message).toBe(
    "The deployed canary gate did not execute any tests. Correlation ID: test-empty.",
  );
});

test("types and sanitizes a malformed deployed canary report", () => {
  const error = Effect.runSync(
    deployedCanaryTestCount("not json", "test-correlation").pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(DeployedCanaryError);
  expect(error.code).toBe("OBS_DEPLOYED_CANARY_REPORT_INVALID");
  expect(error.correlationId).toBe("test-correlation");
  expect(error.message).toBe(
    "The deployed canary test report is malformed. Correlation ID: test-correlation.",
  );
});

test("types and sanitizes an unexpected deployed canary failure", async () => {
  const missingTemporaryDirectory = join(tmpdir(), "missing-observability-deployed-canary");
  const result = await execute({
    command: [process.execPath, "run", "test:canary:deployed"],
    cwd: projectRoot,
    env: {
      ...process.env,
      OBSERVABILITY_E2E_DEPLOYED: "1",
      TMPDIR: missingTemporaryDirectory,
      TMP: missingTemporaryDirectory,
      TEMP: missingTemporaryDirectory,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("OBS_DEPLOYED_CANARY_UNEXPECTED:");
  expect(result.stderr).not.toContain(missingTemporaryDirectory);
});

test("selects a package by slug", async () => {
  await withReleaseRepository(async ({ runRelease }) => {
    const result = await runRelease(["minor", "--package", "beta", "--dry-run"]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "release @equipe-tech/beta: 4.5.6 -> 4.6.0 (beta@4.6.0) [dry-run]\n",
      stderr: "",
    });
  });
});

test("rejects a missing package slug without treating dry-run as the value", async () => {
  await withReleaseRepository(async ({ runRelease }) => {
    const result = await runRelease(["patch", "--package", "--dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("The --package option requires a package slug.");
    expect(result.stderr).toContain("Usage: bun scripts/release.ts");
    expect(result.stderr).not.toContain("Unknown release package --dry-run.");
  });
});

test("rejects an unknown package slug", async () => {
  await withReleaseRepository(async ({ runRelease }) => {
    const result = await runRelease(["patch", "--package", "unknown", "--dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown release package unknown.");
  });
});

test("rejects a dirty working tree before a release", async () => {
  await withReleaseRepository(async ({ root, runRelease }) => {
    await writeFile(join(root, "dirty.txt"), "dirty\n");
    const result = await runRelease(["patch", "--package", "alpha"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "The working tree has uncommitted changes. Commit or stash them before a release.",
    );
    expect(await readFile(join(root, "packages", "alpha", "package.json"), "utf8")).toBe(
      manifest("@equipe-tech/alpha", "1.2.3"),
    );
  });
});

test("dry-run leaves repository state unchanged", async () => {
  await withReleaseRepository(async ({ root, runRelease }) => {
    const head = await runGit(root, ["rev-parse", "HEAD"]);
    const alpha = await readFile(join(root, "packages", "alpha", "package.json"), "utf8");
    const beta = await readFile(join(root, "packages", "beta", "package.json"), "utf8");
    const result = await runRelease(["major", "--package", "alpha", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(await runGit(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(await runGit(root, ["status", "--porcelain"])).toBe("");
    expect(await runGit(root, ["tag", "--list"])).toBe("");
    expect(await readFile(join(root, "packages", "alpha", "package.json"), "utf8")).toBe(alpha);
    expect(await readFile(join(root, "packages", "beta", "package.json"), "utf8")).toBe(beta);
  });
});

test("updates the parsed version field and preserves manifest formatting", async () => {
  await withReleaseRepository(async ({ root, runRelease }) => {
    const alphaPath = join(root, "packages", "alpha", "package.json");
    const before =
      '{\n\t"description": "1.2.3",\n\t"name": "@equipe-tech/alpha",\n\t"version":"1.2.3",\n\t"metadata": { "version": "1.2.3" }\n}\n\n';
    const after =
      '{\n\t"description": "1.2.3",\n\t"name": "@equipe-tech/alpha",\n\t"version":"1.2.4",\n\t"metadata": { "version": "1.2.3" }\n}\n\n';
    await writeFile(alphaPath, before);
    await runGit(root, ["add", "packages/alpha/package.json"]);
    await runGit(root, ["commit", "--quiet", "-m", "test: custom manifest formatting"]);
    const result = await runRelease(["patch", "--package", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(alphaPath, "utf8")).toBe(after);
  });
});

test("commits only the selected manifest and tags that commit", async () => {
  await withReleaseRepository(async ({ root, runRelease }) => {
    const alphaPath = join(root, "packages", "alpha", "package.json");
    const betaPath = join(root, "packages", "beta", "package.json");
    const alphaBefore = await readFile(alphaPath, "utf8");
    const betaBefore = await readFile(betaPath, "utf8");
    const result = await runRelease(["patch", "--package", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readFile(alphaPath, "utf8")).not.toBe(alphaBefore);
    expect(await readFile(alphaPath, "utf8")).toBe(manifest("@equipe-tech/alpha", "1.2.4"));
    expect(await readFile(betaPath, "utf8")).toBe(betaBefore);
    const commit = await runGit(root, ["rev-parse", "HEAD"]);
    expect(await runGit(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe(
      "packages/alpha/package.json",
    );
    expect(await runGit(root, ["rev-list", "-n", "1", "alpha@1.2.4"])).toBe(commit);
    expect(await runGit(root, ["status", "--porcelain"])).toBe("");
  });
});
