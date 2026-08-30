import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "bun:test";
import {
  checkPackageBoundaries,
  decodePackageManifest,
  sourceRole,
} from "../../scripts/package-boundaries.ts";

const projects = join(import.meta.dirname, "fixtures", "projects");

const ruleNames = (
  violations: Awaited<ReturnType<typeof checkPackageBoundaries>>,
): ReadonlyArray<string> => violations.map((violation) => violation.rule).toSorted();

const adapterPaths = [
  "packages/nestjs/src/TelemetryModule.ts",
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
    const policyRules = ruleNames(violations).filter(
      (rule) => rule !== "boundary/undeclared-dependency",
    );
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

  it("classifies every production role by repository-relative ownership", () => {
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
