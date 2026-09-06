import { expect, test } from "bun:test";
import { join } from "node:path";

test("rejects an unknown release slug before reading a manifest", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "scripts/release-candidate.ts",
      "--package",
      "unknown",
      "--version",
      "1.0.0",
      "--output",
      join(import.meta.dirname, ".unknown-release-candidate"),
    ],
    { cwd: join(import.meta.dirname, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Unknown release package unknown.");
  expect(stderr).not.toContain("ENOENT");
});
