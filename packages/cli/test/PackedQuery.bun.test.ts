import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("packed query export", () => {
  test("imports and uses the query entrypoint from the packed package", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-packed-query-"));
    const packageRoot = join(import.meta.dir, "..");
    try {
      await Bun.$`bun pm pack --destination ${root}`.cwd(packageRoot).quiet();
      const archive = (await readdir(root)).find((entry) => entry.endsWith(".tgz"));
      if (archive === undefined) throw new Error("Packed CLI archive was not created.");
      await writeFile(join(root, "package.json"), '{"type":"module"}\n');
      await Bun.$`bun add ${join(root, archive)}`.cwd(root).quiet();
      await writeFile(
        join(root, "query.mjs"),
        'import { Effect } from "effect";\nimport { compileManagedQuery, parseManagedQuery } from "@equipe-tech/observability-cli/query";\nconst query = await Effect.runPromise(parseManagedQuery(\'signal(logs) | where event.name == "cli.operation"\'));\nconsole.log(compileManagedQuery(query, { dataset: "observability-prod-logs", language: "apl", signals: ["cli.operation", "cli.command"] }).text);\n',
      );
      const output = await Bun.$`bun query.mjs`.cwd(root).text();
      expect(output).toContain("['event.name'] in ('cli.operation', 'cli.command')");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
