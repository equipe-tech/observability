import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Contract } from "../packages/telemetry/src/index.ts";
import { parseOperationsManifest } from "../packages/cli/src/OperationsManifest.ts";
import {
  classifyPackageChange,
  versionSatisfiesBreakLane,
  type DeclaredPackageBreak,
  type PackageSurface,
} from "../scripts/compatibility-gate.ts";

const packageSurface = (
  version: string,
  exports: ReadonlyArray<string>,
  peerDependencies: ReadonlyArray<string> = [],
  dependencies: ReadonlyArray<string> = [],
): PackageSurface => ({
  name: "@equipe-tech/example",
  version,
  type: "module",
  exports,
  exportConditions: exports.map((entry) => `${entry}:import:./dist/index.js`),
  runtimeEntrypoints: exports,
  declarationSymbols: exports.map((entry) => `${entry}:Example`),
  dependencies,
  peerDependencies,
  optionalPeers: [],
  publicErrorCodes: ["OBS_EXAMPLE_FAILED"],
});

const declaredBreak = (code: string, candidateVersion: string): DeclaredPackageBreak => ({
  scope: "package",
  package: "@equipe-tech/example",
  code,
  path: "fixture",
  candidateVersion,
  migrationGuide: "docs/migration-0.3.md",
});

describe("compatibility gate", () => {
  test("keeps the compatibility code registry complete", () => {
    const fixtures = JSON.parse(readFileSync("tools/compatibility/contract-fixtures.json", "utf8"));
    expect(fixtures.map((fixture: { readonly code: string }) => fixture.code)).toEqual(
      Contract.compatibilityCodes,
    );
    expect(Contract.compatibilityCodes).toEqual([
      "OBS_COMPAT_EVENT_ADDED",
      "OBS_COMPAT_EVENT_REMOVED",
      "OBS_COMPAT_EVENT_RENAMED",
      "OBS_COMPAT_EVENT_KIND_CHANGED",
      "OBS_COMPAT_OUTCOME_MEANING_CHANGED",
      "OBS_COMPAT_ATTRIBUTE_ADDED",
      "OBS_COMPAT_ATTRIBUTE_REMOVED",
      "OBS_COMPAT_ATTRIBUTE_REQUIRED",
      "OBS_COMPAT_ATTRIBUTE_CLASSIFICATION_CHANGED",
      "OBS_COMPAT_ATTRIBUTE_METRIC_LABEL_CHANGED",
      "OBS_COMPAT_METRIC_ADDED",
      "OBS_COMPAT_METRIC_REMOVED",
      "OBS_COMPAT_METRIC_RENAMED",
      "OBS_COMPAT_METRIC_KIND_CHANGED",
      "OBS_COMPAT_METRIC_UNIT_CHANGED",
      "OBS_COMPAT_METRIC_BOUNDARIES_CHANGED",
      "OBS_COMPAT_METRIC_ATTRIBUTE_ADDED",
      "OBS_COMPAT_METRIC_ATTRIBUTE_REMOVED",
      "OBS_COMPAT_METRIC_ATTRIBUTE_CLASSIFICATION_CHANGED",
      "OBS_COMPAT_METRIC_CARDINALITY_LOWERED",
      "OBS_COMPAT_METRIC_ALLOWED_VALUES_NARROWED",
      "OBS_COMPAT_AUDIT_ACTION_ADDED",
      "OBS_COMPAT_AUDIT_ACTION_REMOVED",
      "OBS_COMPAT_AUDIT_ACTION_CHANGED",
      "OBS_COMPAT_ALIAS_ADDED",
      "OBS_COMPAT_ALIAS_REMOVED_EARLY",
      "OBS_COMPAT_ALIAS_WINDOW_RESET",
      "OBS_COMPAT_ALIAS_WINDOW_EXPIRED",
      "OBS_COMPAT_BROWSER_ENVELOPE_CHANGED",
      "OBS_COMPAT_RETENTION_WINDOW_RESET",
    ]);
  });

  test("freezes the maximum manifest retention in both contract artifacts", async () => {
    const manifest = await Effect.runPromise(
      parseOperationsManifest(readFileSync("observability/operations.yaml", "utf8")),
    );
    const maximumRetention = Math.max(...manifest.retention.map((entry) => entry.days));
    const baseline = JSON.parse(readFileSync("observability/compatibility/baseline.json", "utf8"));
    const candidate = JSON.parse(
      readFileSync("observability/compatibility/candidate.json", "utf8"),
    );
    expect(baseline.contract.retentionWindowDays).toBe(maximumRetention);
    expect(candidate.retentionWindowDays).toBe(maximumRetention);
  });

  test("accepts additive exports and rejects undeclared removals", () => {
    const baseline = packageSurface("0.2.1", ["."]);
    const additive = packageSurface("0.2.1", [".", "./testing"]);
    expect(
      classifyPackageChange(baseline, additive, "0.2.2", []).every((entry) => entry.satisfied),
    ).toBe(true);
    const removal = packageSurface("0.2.1", []);
    expect(
      classifyPackageChange(baseline, removal, "0.2.1", []).some((entry) => !entry.satisfied),
    ).toBe(true);
  });

  test("uses minor as the 0.x break lane and major after 1.0", () => {
    expect(versionSatisfiesBreakLane("0.2.1", "0.3.0")).toBe(true);
    expect(versionSatisfiesBreakLane("0.2.1", "0.2.2")).toBe(false);
    expect(versionSatisfiesBreakLane("1.4.2", "2.0.0")).toBe(true);
    expect(versionSatisfiesBreakLane("1.4.2", "1.5.0")).toBe(false);
    const baseline = packageSurface("0.2.1", ["."]);
    const candidate = packageSurface("0.2.1", []);
    const findings = classifyPackageChange(baseline, candidate, "0.3.0", [
      declaredBreak("OBS_PACKAGE_EXPORT_REMOVED", "0.3.0"),
      declaredBreak("OBS_PACKAGE_EXPORT_CONDITION_REMOVED", "0.3.0"),
      declaredBreak("OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING", "0.3.0"),
      declaredBreak("OBS_PACKAGE_SYMBOL_REMOVED", "0.3.0"),
    ]);
    expect(findings.every((entry) => entry.satisfied)).toBe(true);
  });

  test("rejects peer narrowing and dependency category changes", () => {
    const baseline = packageSurface("0.2.1", ["."], [], ["effect@^4.0.0"]);
    const candidate = packageSurface("0.2.1", ["."], ["effect@4.0.0"], []);
    const findings = classifyPackageChange(baseline, candidate, "0.2.2", []);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "OBS_PACKAGE_DEPENDENCY_CATEGORY_CHANGED",
        satisfied: false,
      }),
    );
  });

  test("pins v0.2.1 instead of current head and wires the exact CI command", () => {
    const baseline = JSON.parse(readFileSync("observability/compatibility/baseline.json", "utf8"));
    expect(baseline.source).toEqual({
      tag: "v0.2.1",
      commit: "a5ab6997536f9d3af797429783f65c9e68a0dfa0",
    });
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain("- run: bun run compat");
    expect(readFileSync("package.json", "utf8")).toContain(
      '"compat": "bun scripts/compatibility-gate.ts"',
    );
  });
});
