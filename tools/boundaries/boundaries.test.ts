import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "vite-plus/test";
import { evaluateSpecifier, type BoundaryRole } from "../../scripts/package-boundaries.ts";

type Fixture = {
  readonly file: string;
  readonly role: BoundaryRole;
  readonly specifier: string;
  readonly rules: ReadonlyArray<string>;
};

const fixtures: ReadonlyArray<Fixture> = [
  {
    file: "domain-otlp.ts.txt",
    role: "domain",
    specifier: "effect/unstable/observability",
    rules: ["boundary/domain-forbidden-otlp"],
  },
  {
    file: "domain-provider.ts.txt",
    role: "domain",
    specifier: "@sentry/node",
    rules: ["boundary/domain-forbidden-provider"],
  },
  {
    file: "domain-metric.ts.txt",
    role: "domain",
    specifier: "@equipe-tech/observability/metrics",
    rules: ["boundary/domain-forbidden-metric-api"],
  },
  {
    file: "adapter-otlp.ts.txt",
    role: "adapter",
    specifier: "effect/unstable/observability",
    rules: [],
  },
  {
    file: "bootstrap-core.ts.txt",
    role: "bootstrap",
    specifier: "@equipe-tech/observability/node",
    rules: [],
  },
];

describe("package boundaries", () => {
  for (const fixture of fixtures) {
    it(`evaluates ${fixture.file}`, async () => {
      const source = await readFile(join(import.meta.dirname, "fixtures", fixture.file), "utf8");
      assert.include(source, fixture.specifier);
      const rules = evaluateSpecifier(fixture.role, fixture.file, fixture.specifier).map(
        (violation) => violation.rule,
      );
      assert.deepEqual(rules, fixture.rules);
    });
  }
});
