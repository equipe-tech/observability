import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Schema } from "effect";

const projectRoot = join(import.meta.dirname, "..");
const BuildConfig = Schema.Struct({
  compilerOptions: Schema.Struct({ noEmitOnError: Schema.Literal(true) }),
});
const decodeBuildConfig = Schema.decodeUnknownSync(BuildConfig);

test("package builds disable emit after type errors", async () => {
  for (const packageName of ["telemetry", "nestjs", "cli"]) {
    const value: unknown = JSON.parse(
      await readFile(join(projectRoot, "packages", packageName, "tsconfig.build.json"), "utf8"),
    );
    assert.equal(decodeBuildConfig(value).compilerOptions.noEmitOnError, true);
  }
});

test("a failed cross-root build leaves every source tree clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "build-hygiene-"));
  try {
    await mkdir(join(root, "packages", "alpha", "src"), { recursive: true });
    await mkdir(join(root, "packages", "beta", "src"), { recursive: true });
    await writeFile(
      join(root, "packages", "alpha", "src", "index.ts"),
      'export { value } from "../../beta/src/value.ts";\n',
    );
    await writeFile(join(root, "packages", "beta", "src", "value.ts"), "export const value = 1;\n");
    await writeFile(
      join(root, "packages", "alpha", "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            declaration: true,
            noEmitOnError: true,
            outDir: "dist",
            rootDir: "src",
            rewriteRelativeImportExtensions: true,
          },
          include: ["src/**/*.ts"],
        },
        undefined,
        2,
      )}\n`,
    );
    const compiler = Bun.spawn(
      [
        "bun",
        join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "packages/alpha/tsconfig.json",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    assert.notEqual(await compiler.exited, 0);
    const emitted: Array<string> = [];
    const sourceArtifacts = new Bun.Glob("packages/*/src/**/*.{js,d.ts}");
    for await (const artifact of sourceArtifacts.scan({ cwd: root })) emitted.push(artifact);
    assert.deepEqual(emitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
