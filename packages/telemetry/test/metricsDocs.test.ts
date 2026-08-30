import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

const metricsDocumentation = await readFile(
  new URL("../../../docs/metrics.md", import.meta.url),
  "utf8",
);

const migrationDocumentation = await readFile(
  new URL("../../../docs/migration-0.3.md", import.meta.url),
  "utf8",
);

describe("metric policy documentation", () => {
  it("uses a valid dotted label in the executable example", () => {
    expect(metricsDocumentation).toContain(
      'orders.add(1, [{ key: "deployment.region", value: "south" }]);',
    );
    expect(metricsDocumentation).not.toContain('{ key: "region"');
  });

  it("states every metric label policy and error code", () => {
    for (const contract of [
      "at least two lowercase dotted segments",
      "String values contain 1 to 64 characters",
      "100 distinct values per label per instrument lifetime",
      "`POLICY_BLOCKED`",
      "`LIMIT_EXCEEDED`",
      "`trace.id`",
      "`span.id`",
      "`user.id`",
      "`session.id`",
    ]) {
      expect(metricsDocumentation).toContain(contract);
    }
  });

  it("gives exact migration outcomes", () => {
    expect(migrationDocumentation).toContain("no máximo 64 caracteres");
    expect(migrationDocumentation).toContain("no máximo 100 valores distintos por rótulo");
    expect(migrationDocumentation).toContain("código `POLICY_BLOCKED`");
    expect(migrationDocumentation).toContain("código `LIMIT_EXCEEDED`");
  });
});
