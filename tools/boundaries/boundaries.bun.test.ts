import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "bun:test";
import {
  checkPackageBoundaries,
  decodePackageManifest,
  defineOwnership,
  sourceRole,
} from "../../scripts/package-boundaries.ts";

const projects = join(import.meta.dirname, "fixtures", "projects");

const ruleNames = (
  violations: Awaited<ReturnType<typeof checkPackageBoundaries>>,
): ReadonlyArray<string> => violations.map((violation) => violation.rule).toSorted();

const adapterPaths = [
  "packages/nestjs/src/TelemetryModule.ts",
  "packages/sentry/src/node/SentryDefectAdapter.ts",
  "packages/react/src/index.ts",
  "packages/telemetry/src/MetricsRuntime.ts",
  "packages/telemetry/src/PolicyOtlpLogger.ts",
  "packages/telemetry/src/Telemetry.ts",
  "packages/telemetry/src/node/Observability.ts",
  "packages/telemetry/src/profile/LifecycleRegistry.ts",
  "packages/telemetry/src/profile/ObservabilityAdapter.ts",
  "packages/telemetry/src/testing/index.ts",
  "packages/telemetry/src/trace/HttpServerOtlpTracer.ts",
];

const mutateOwnedPath = async (ownedPath: string): Promise<ReadonlyArray<string>> => {
  const temporary = await mkdtemp(join(tmpdir(), "boundaries-ownership-"));
  try {
    await cp(join(projects, "allowed"), temporary, { recursive: true });
    const source = join(temporary, ownedPath);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'import type {} from "@sentry/node";\n');
    assert.deepEqual(await checkPackageBoundaries(temporary), []);
    const mutation = join(temporary, "packages", "telemetry", "src", "mutation.ts");
    await rename(source, mutation);
    return ruleNames(await checkPackageBoundaries(temporary));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

describe("package boundaries", () => {
  it("runs every role policy through type-only imports in fixture projects", async () => {
    const violations = await checkPackageBoundaries(join(projects, "violations"));
    const policyRules = ruleNames(violations).filter((rule) => rule.includes("-forbidden-"));
    assert.deepEqual(policyRules, [
      "boundary/bootstrap-forbidden-framework",
      "boundary/bootstrap-forbidden-provider",
      "boundary/core-forbidden-framework",
      "boundary/core-forbidden-metric-api",
      "boundary/core-forbidden-otlp",
      "boundary/core-forbidden-provider",
      "boundary/core-forbidden-runtime-platform",
      "boundary/domain-forbidden-metric-api",
      "boundary/domain-forbidden-otlp",
      "boundary/domain-forbidden-provider",
      "boundary/domain-forbidden-runtime-platform",
    ]);
  });

  it("rejects undeclared runtime and declaration imports in every role", async () => {
    const violations = await checkPackageBoundaries(join(projects, "violations"));
    const undeclared = violations.filter(
      (violation) => violation.rule === "boundary/undeclared-dependency",
    );
    for (const role of ["adapter", "bootstrap", "core", "domain"] as const) {
      const roleViolations = undeclared.filter((violation) => sourceRole(violation.file) === role);
      assert.equal(
        roleViolations.some((violation) => violation.specifier.endsWith("-runtime")),
        true,
      );
      assert.equal(
        roleViolations.some((violation) => violation.specifier.endsWith("-declaration")),
        true,
      );
    }
  });

  it("allows declared imports according to all four role policies", async () => {
    assert.deepEqual(await checkPackageBoundaries(join(projects, "allowed")), []);
  });

  it("allows the root producer and rejects every direct domain metric API", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-metric-producer-"));
    try {
      await cp(join(projects, "allowed"), temporary, { recursive: true });
      const contractDirectory = join(temporary, "packages/telemetry/src/contract");
      await writeFile(
        join(contractDirectory, "metric-producer.ts"),
        'import type { MetricProducer } from "@equipe-tech/observability";\nvoid (0 satisfies MetricProducer<never>);\n',
      );
      const source = join(contractDirectory, "direct-metrics.ts");
      await writeFile(
        source,
        [
          'import type {} from "effect/Metric";',
          'import type {} from "@opentelemetry/api";',
          'import type {} from "@equipe-tech/observability/metrics";',
        ].join("\n"),
      );
      const allViolations = await checkPackageBoundaries(temporary);
      assert.equal(
        allViolations.some((violation) => violation.file.endsWith("metric-producer.ts")),
        false,
      );
      const violations = allViolations.filter(
        (violation) =>
          violation.file.endsWith("direct-metrics.ts") &&
          violation.rule === "boundary/domain-forbidden-metric-api",
      );
      assert.deepEqual(
        violations
          .map((violation) => [violation.rule, violation.specifier])
          .toSorted((left, right) => String(left).localeCompare(String(right))),
        [
          ["boundary/domain-forbidden-metric-api", "@equipe-tech/observability/metrics"],
          ["boundary/domain-forbidden-metric-api", "@opentelemetry/api"],
          ["boundary/domain-forbidden-metric-api", "effect/Metric"],
        ],
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("parses external exports and import-equals declarations", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-declarations-"));
    try {
      await cp(join(projects, "violations"), temporary, { recursive: true });
      await cp(
        join(import.meta.dirname, "fixtures", "external-import-equals.txt"),
        join(temporary, "packages", "telemetry", "src", "external-import-equals.ts"),
      );
      const violations = await checkPackageBoundaries(temporary);
      const declarationSpecifiers = violations
        .filter(
          (violation) =>
            violation.file.endsWith("external-declarations.ts") ||
            violation.file.endsWith("external-import-equals.ts"),
        )
        .map((violation) => violation.specifier)
        .toSorted();
      assert.deepEqual(declarationSpecifiers, [
        "undeclared-export-all",
        "undeclared-export-type",
        "undeclared-import-equals",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects dynamic, cross-package source, and absolute fixture imports", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-path-fixtures-"));
    try {
      await cp(join(projects, "violations"), temporary, { recursive: true });
      for (const fixture of [
        {
          source: "dynamic-import.txt",
          target: join("packages", "telemetry", "src", "contract", "dynamic.ts"),
        },
        {
          source: "cross-package-import.txt",
          target: join("packages", "nestjs", "src", "cross-package.ts"),
        },
        {
          source: "absolute-import.txt",
          target: join("packages", "telemetry", "src", "absolute.ts"),
        },
      ]) {
        await cp(
          join(import.meta.dirname, "fixtures", fixture.source),
          join(temporary, fixture.target),
        );
      }
      const violations = await checkPackageBoundaries(temporary);
      assert.equal(
        violations.some(
          (violation) =>
            violation.file.endsWith("contract/dynamic.ts") &&
            violation.rule === "boundary/domain-forbidden-metric-api",
        ),
        true,
      );
      assert.equal(
        violations.some(
          (violation) =>
            violation.file.endsWith("cross-package.ts") &&
            violation.rule === "boundary/cross-package-source-import",
        ),
        true,
      );
      assert.equal(
        violations.some(
          (violation) =>
            violation.file.endsWith("absolute.ts") &&
            violation.rule === "boundary/absolute-file-import",
        ),
        true,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  for (const mutation of [
    {
      name: "static",
      source: 'import "@sentry/node";\n',
      rule: "boundary/core-forbidden-provider",
    },
    {
      name: "type-only",
      source: 'import type {} from "@sentry/node";\n',
      rule: "boundary/core-forbidden-provider",
    },
    {
      name: "export",
      source: 'export type {} from "@sentry/node";\n',
      rule: "boundary/core-forbidden-provider",
    },
    {
      name: "import-equals",
      source: 'import Provider = require("@sentry/node");\nvoid Provider;\n',
      rule: "boundary/core-forbidden-provider",
    },
    {
      name: "dynamic",
      source: 'export const load = () => import("@sentry/node");\n',
      rule: "boundary/core-forbidden-provider",
    },
    {
      name: "relative cross-package",
      source: 'export type {} from "../../nestjs/src/TelemetryModule.ts";\n',
      rule: "boundary/cross-package-source-import",
    },
    {
      name: "absolute",
      source: 'import "/tmp/observability-boundary.ts";\n',
      rule: "boundary/absolute-file-import",
    },
  ]) {
    it(`keeps ${mutation.name} import parsing load-bearing`, async () => {
      const temporary = await mkdtemp(join(tmpdir(), "boundaries-import-mutation-"));
      try {
        await cp(join(projects, "allowed"), temporary, { recursive: true });
        await writeFile(
          join(temporary, "packages", "telemetry", "src", "mutation.ts"),
          mutation.source,
        );
        assert.equal(
          (await checkPackageBoundaries(temporary)).some(
            (violation) => violation.rule === mutation.rule,
          ),
          true,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  it("makes the core fallback load-bearing", async () => {
    const violations = await checkPackageBoundaries(join(projects, "violations"));
    assert.equal(
      violations.some(
        (violation) =>
          violation.file === "packages/telemetry/src/index.ts" &&
          violation.rule === "boundary/core-forbidden-framework",
      ),
      true,
    );
  });

  it("makes domain ownership load-bearing", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-domain-"));
    try {
      await cp(join(projects, "allowed"), temporary, { recursive: true });
      await rename(
        join(temporary, "packages", "telemetry", "src", "contract", "framework.ts"),
        join(temporary, "packages", "telemetry", "src", "framework.ts"),
      );
      assert.deepEqual(ruleNames(await checkPackageBoundaries(temporary)), [
        "boundary/core-forbidden-framework",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("makes shebang parsing and bootstrap ownership load-bearing", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-bootstrap-"));
    try {
      await cp(join(projects, "allowed"), temporary, { recursive: true });
      assert.deepEqual(await checkPackageBoundaries(temporary), []);
      await rename(
        join(temporary, "packages", "cli", "src", "main.ts"),
        join(temporary, "packages", "cli", "src", "Cli.ts"),
      );
      assert.deepEqual(ruleNames(await checkPackageBoundaries(temporary)), [
        "boundary/domain-forbidden-metric-api",
        "boundary/domain-forbidden-metric-api",
        "boundary/domain-forbidden-otlp",
        "boundary/domain-forbidden-runtime-platform",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  for (const adapterPath of adapterPaths) {
    it(`makes the adapter ownership for ${adapterPath} load-bearing`, async () => {
      assert.deepEqual(await mutateOwnedPath(adapterPath), ["boundary/core-forbidden-provider"]);
    });
  }

  it("rejects provider and OTLP imports from Sentry policy", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-sentry-policy-"));
    try {
      await cp(join(projects, "allowed"), temporary, { recursive: true });
      const directory = join(temporary, "packages", "sentry", "src", "policy");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(temporary, "packages", "sentry", "package.json"),
        JSON.stringify({
          name: "sentry",
          dependencies: {
            "@opentelemetry/exporter-trace-otlp-http": "1",
            "@sentry/browser": "1",
          },
        }),
      );
      await writeFile(
        join(directory, "invalid.ts"),
        'import "@opentelemetry/exporter-trace-otlp-http";\nimport "@sentry/browser";\n',
      );
      assert.deepEqual(ruleNames(await checkPackageBoundaries(temporary)), [
        "boundary/domain-forbidden-otlp",
        "boundary/domain-forbidden-provider",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects duplicate ownership selectors", () => {
    assert.throws(
      () =>
        defineOwnership([
          { kind: "prefix", path: "packages/sentry/src/", role: "adapter" },
          { kind: "prefix", path: "packages/sentry/src/", role: "adapter" },
        ]),
      /Duplicate package ownership selector "prefix:packages\/sentry\/src\/"/,
    );
  });

  it("classifies every production role by repository-relative ownership", () => {
    assert.equal(sourceRole("packages/sentry/src/policy/DefectProjection.ts"), "domain");
    assert.equal(sourceRole("packages/sentry/src/node/SentryDefectAdapter.ts"), "adapter");
    assert.equal(sourceRole("packages/telemetry/src/index.ts"), "core");
    assert.equal(sourceRole("packages/telemetry/src/contract/EventName.ts"), "domain");
    assert.equal(sourceRole("packages/telemetry/src/trace/HttpServerOtlpTracer.ts"), "adapter");
    assert.equal(sourceRole("packages/cli/src/main.ts"), "bootstrap");
  });

  it("rejects malformed package manifests through the production decoder", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-manifest-"));
    try {
      const packageDirectory = join(temporary, "packages", "invalid");
      await mkdir(join(packageDirectory, "src"), { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), '{"name":""}');
      await writeFile(join(packageDirectory, "src", "index.ts"), 'import "effect";\n');
      await assert.rejects(checkPackageBoundaries(temporary));
      assert.throws(() => decodePackageManifest({ name: "" }));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
