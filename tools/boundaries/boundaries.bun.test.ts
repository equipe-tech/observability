import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
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

describe("package boundaries", () => {
  it("runs every production rule through project discovery, manifest parsing, and import scanning", async () => {
    const violations = await checkPackageBoundaries(join(projects, "violations"));
    assert.deepEqual(ruleNames(violations), [
      "boundary/core-forbidden-framework",
      "boundary/domain-forbidden-metric-api",
      "boundary/domain-forbidden-otlp",
      "boundary/domain-forbidden-provider",
      "boundary/undeclared-dependency",
    ]);
  });

  it("allows declared provider and exporter imports only in owned adapter and bootstrap paths", async () => {
    assert.deepEqual(await checkPackageBoundaries(join(projects, "allowed")), []);
  });

  it("classifies every production role by repository-relative path ownership", () => {
    assert.equal(sourceRole("packages/telemetry/src/index.ts"), "core");
    assert.equal(sourceRole("packages/telemetry/src/contract/EventName.ts"), "domain");
    assert.equal(sourceRole("packages/telemetry/src/trace/HttpServerOtlpTracer.ts"), "adapter");
    assert.equal(sourceRole("packages/cli/src/main.ts"), "bootstrap");
  });

  it("distinguishes an adapter-path mutation from the allowed project", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "boundaries-mutation-"));
    try {
      await cp(join(projects, "allowed"), temporary, { recursive: true });
      const domainDirectory = join(temporary, "packages", "telemetry", "src", "contract");
      await mkdir(domainDirectory, { recursive: true });
      await rename(
        join(temporary, "packages", "telemetry", "src", "trace", "exporter.ts"),
        join(domainDirectory, "exporter.ts"),
      );
      assert.deepEqual(ruleNames(await checkPackageBoundaries(temporary)), [
        "boundary/domain-forbidden-otlp",
        "boundary/domain-forbidden-provider",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
