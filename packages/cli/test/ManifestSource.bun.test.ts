import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistOperationsPlan } from "../src/ManifestSource.ts";

describe("operations plan persistence", () => {
  test("retains the current plan and prunes only stale generated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-plan-persistence-"));
    const output = join(root, ".observability");
    const staleDigest = "a".repeat(64);
    const currentDigest = "b".repeat(64);
    const staleName = `plan-${staleDigest}.json`;
    const currentName = `plan-${currentDigest}.json`;
    const unrelatedName = "plan-not-generated.json";
    try {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, unrelatedName), "keep\n", { mode: 0o644 });
      await writeFile(join(output, staleName), "stale\n", { mode: 0o400 });
      await chmod(join(output, staleName), 0o400);
      await mkdir(join(output, `plan-${"c".repeat(64)}.json`));

      const path = await Effect.runPromise(
        persistOperationsPlan(root, currentDigest, '{"version":1}\n'),
      );

      expect(path).toBe(join(output, currentName));
      expect((await readdir(output)).sort()).toEqual(
        [currentName, unrelatedName, `plan-${"c".repeat(64)}.json`].sort(),
      );
      expect(await readFile(join(output, unrelatedName), "utf8")).toBe("keep\n");
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
