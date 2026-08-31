import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("regenerates the committed observability contract index exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observability-contract-index-"));
  const output = join(directory, "contract.json");
  try {
    const processHandle = Bun.spawn(["bun", "observability/contract-index.js", output], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      await readFile(join(import.meta.dir, "../../../observability/contract.json"), "utf8"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
