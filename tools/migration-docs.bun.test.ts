import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";

test("the 0.3 migration documents the WideEventFields replacement", async () => {
  const migration = await readFile(
    join(import.meta.dirname, "..", "docs", "migration-0.3.md"),
    "utf8",
  );
  assert.match(migration, /`WideEventFields` foi removido/);
  assert.match(migration, /Substitua-o por `EventAttributes`/);
  assert.match(migration, /import type \{ EventAttributes \} from "@equipe-tech\/observability";/);
});
