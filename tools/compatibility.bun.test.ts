import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { browserEnvelopeMetadata } from "../packages/telemetry/src/BrowserEvents.ts";
import { Contract } from "../packages/telemetry/src/index.ts";
import { parseOperationsManifest } from "../packages/cli/src/OperationsManifest.ts";
import {
  classifyPackageChange,
  PackageCompatibilityCode,
  releaseIntegrityIssue,
  versionSatisfiesBreakLane,
  type DeclaredPackageBreak,
  type PackageFinding,
  type PackageSurface,
} from "../scripts/compatibility-gate.ts";
import { generateCompatibilityCandidate } from "../scripts/generate-compatibility-candidate.ts";
import {
  contractCompatibilityFixtures,
  packageCompatibilityFixtures,
} from "./compatibility-fixtures.ts";

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

const declaredBreak = (
  code: PackageCompatibilityCode,
  candidateVersion: string,
  path: string,
): DeclaredPackageBreak => ({
  scope: "package",
  package: "@equipe-tech/example",
  code,
  path,
  candidateVersion,
  migrationGuide: "docs/migration-0.3.md",
});

describe("compatibility gate", () => {
  test("executes complete discriminating contract fixtures", () => {
    const fixtureIds = contractCompatibilityFixtures.map((fixture) => fixture.id);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect([...fixtureIds].sort()).toEqual([...Contract.CompatibilityCode.literals].sort());
    for (const fixture of contractCompatibilityFixtures) {
      const arranged = fixture.arrange();
      const report = Contract.classifyContractChange(arranged);
      const findings = report.findings.filter((finding) => finding.code === fixture.expected.code);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: fixture.expected.code,
        path: fixture.expected.path,
        severity: fixture.expected.severity,
        aliasStatus: fixture.expected.aliasStatus,
      });
      expect(report.accepted).toBe(fixture.expected.accepted);
      const control = Contract.classifyContractChange({
        baseline: arranged.baseline,
        candidate: arranged.control,
        now: arranged.now,
      });
      expect(control.findings.some((finding) => finding.code === fixture.expected.code)).toBe(
        false,
      );
    }
  });

  test("executes complete discriminating package fixtures", () => {
    const fixtureIds = packageCompatibilityFixtures.map((fixture) => fixture.id);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect([...fixtureIds].sort()).toEqual([...PackageCompatibilityCode.literals].sort());
    for (const fixture of packageCompatibilityFixtures) {
      const findings = classifyPackageChange(
        fixture.baseline,
        fixture.candidate,
        fixture.declaredVersion,
        fixture.declaredBreaks,
      );
      const matches = findings.filter((finding) => finding.code === fixture.expected.code);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        code: fixture.expected.code,
        path: fixture.expected.path,
        severity: fixture.expected.severity,
      });
      expect(findings.every((finding) => finding.satisfied)).toBe(fixture.expected.accepted);
      const control = classifyPackageChange(
        fixture.baseline,
        fixture.control,
        fixture.declaredVersion,
        fixture.declaredBreaks,
      );
      expect(control.some((finding) => finding.code === fixture.expected.code)).toBe(false);
    }
  });

  test("rejects every mutated fixture expectation", () => {
    for (const fixture of contractCompatibilityFixtures) {
      const arranged = fixture.arrange();
      const report = Contract.classifyContractChange(arranged);
      const finding = report.findings.find((entry) => entry.code === fixture.expected.code);
      expect(finding).toBeDefined();
      const matches = (candidate: typeof fixture.expected): boolean =>
        finding?.code === candidate.code &&
        finding.path === candidate.path &&
        finding.severity === candidate.severity &&
        finding.aliasStatus === candidate.aliasStatus &&
        report.accepted === candidate.accepted;
      const alternateCode = Contract.CompatibilityCode.literals.find(
        (code) => code !== fixture.expected.code,
      );
      expect(alternateCode).toBeDefined();
      if (alternateCode !== undefined)
        expect(matches({ ...fixture.expected, code: alternateCode })).toBe(false);
      expect(matches({ ...fixture.expected, path: `${fixture.expected.path}/wrong` })).toBe(false);
      expect(
        matches({
          ...fixture.expected,
          severity: fixture.expected.severity === "breaking" ? "compatible" : "breaking",
        }),
      ).toBe(false);
      expect(
        matches({
          ...fixture.expected,
          aliasStatus: fixture.expected.aliasStatus === "active" ? "expired" : "active",
        }),
      ).toBe(false);
      expect(matches({ ...fixture.expected, accepted: !fixture.expected.accepted })).toBe(false);
    }
    for (const fixture of packageCompatibilityFixtures) {
      const findings = classifyPackageChange(
        fixture.baseline,
        fixture.candidate,
        fixture.declaredVersion,
        fixture.declaredBreaks,
      );
      const finding = findings.find((entry) => entry.code === fixture.expected.code);
      expect(finding).toBeDefined();
      const matches = (candidate: typeof fixture.expected): boolean =>
        finding?.code === candidate.code &&
        finding.path === candidate.path &&
        finding.severity === candidate.severity &&
        findings.every((entry) => entry.satisfied) === candidate.accepted;
      const alternateCode = PackageCompatibilityCode.literals.find(
        (code) => code !== fixture.expected.code,
      );
      expect(alternateCode).toBeDefined();
      if (alternateCode !== undefined)
        expect(matches({ ...fixture.expected, code: alternateCode })).toBe(false);
      expect(matches({ ...fixture.expected, path: `${fixture.expected.path}/wrong` })).toBe(false);
      expect(
        matches({
          ...fixture.expected,
          severity: fixture.expected.severity === "breaking" ? "compatible" : "breaking",
        }),
      ).toBe(false);
      expect(matches({ ...fixture.expected, accepted: !fixture.expected.accepted })).toBe(false);
    }
  });

  test("discriminates alias status at exact retention boundaries", () => {
    const fixture = contractCompatibilityFixtures.find(
      (entry) => entry.id === "OBS_COMPAT_ALIAS_ADDED",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const arranged = fixture.arrange();
    const statusAt = (now: string) =>
      Contract.classifyContractChange({
        baseline: arranged.baseline,
        candidate: arranged.candidate,
        now,
      }).findings.find((finding) => finding.code === "OBS_COMPAT_ALIAS_ADDED")?.aliasStatus;
    expect(statusAt("2026-09-22")).toBe("active");
    expect(statusAt("2026-09-23")).toBe("expiring");
    expect(statusAt("2026-09-29")).toBe("expiring");
    expect(statusAt("2026-09-30")).toBe("expired");
  });

  test("requires exact migration declaration and break lane satisfaction", () => {
    const fixture = packageCompatibilityFixtures.find(
      (entry) => entry.id === "OBS_PACKAGE_EXPORT_REMOVED",
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const declaration = declaredBreak(fixture.expected.code, "0.3.0", fixture.expected.path);
    const classify = (
      version: string,
      breaks: ReadonlyArray<DeclaredPackageBreak>,
    ): PackageFinding => {
      const finding = classifyPackageChange(
        fixture.baseline,
        fixture.candidate,
        version,
        breaks,
      ).find((entry) => entry.code === fixture.expected.code);
      if (finding === undefined)
        throw new Error("Package fixture did not produce its expected code.");
      return finding;
    };
    expect(classify("0.2.2", [{ ...declaration, candidateVersion: "0.2.2" }]).satisfied).toBe(
      false,
    );
    expect(
      classify("0.3.0", [{ ...declaration, path: `${declaration.path}/wrong` }]).satisfied,
    ).toBe(false);
    expect(classify("0.3.0", [declaration]).satisfied).toBe(true);
  });

  test("regenerates the candidate from contract, operations and browser schema metadata", async () => {
    const generated = await generateCompatibilityCandidate();
    const committed = readFileSync("observability/compatibility/candidate.json", "utf8");
    expect(generated).toBe(committed);
    const candidate = JSON.parse(committed);
    expect(candidate.browserEnvelope).toEqual(browserEnvelopeMetadata);
    expect({
      ...browserEnvelopeMetadata,
      eventFields: [...browserEnvelopeMetadata.eventFields, "drift"],
    }).not.toEqual(candidate.browserEnvelope);
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

  test("detects every historical symbol and public error code removal", () => {
    const baseline = JSON.parse(readFileSync("observability/compatibility/baseline.json", "utf8"));
    for (const historical of baseline.packages) {
      for (const symbol of historical.declarationSymbols) {
        const candidate = {
          ...historical,
          declarationSymbols: historical.declarationSymbols.filter(
            (entry: string) => entry !== symbol,
          ),
        };
        expect(classifyPackageChange(historical, candidate, "0.3.0", [])).toContainEqual(
          expect.objectContaining({
            code: "OBS_PACKAGE_SYMBOL_REMOVED",
            path: `symbols/${symbol}`,
            severity: "breaking",
            satisfied: false,
          }),
        );
      }
      for (const code of historical.publicErrorCodes) {
        const candidate = {
          ...historical,
          publicErrorCodes: historical.publicErrorCodes.filter((entry: string) => entry !== code),
        };
        expect(classifyPackageChange(historical, candidate, "0.3.0", [])).toContainEqual(
          expect.objectContaining({
            code: "OBS_PACKAGE_ERROR_CODE_REMOVED",
            path: `publicErrorCodes/${code}`,
            severity: "breaking",
            satisfied: false,
          }),
        );
      }
    }
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
      declaredBreak("OBS_PACKAGE_EXPORT_REMOVED", "0.3.0", "exports/."),
      declaredBreak(
        "OBS_PACKAGE_EXPORT_CONDITION_REMOVED",
        "0.3.0",
        "exportConditions/.:import:./dist/index.js",
      ),
      declaredBreak("OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING", "0.3.0", "runtime/."),
      declaredBreak("OBS_PACKAGE_SYMBOL_REMOVED", "0.3.0", "symbols/.:Example"),
    ]);
    expect(findings.every((entry) => entry.satisfied)).toBe(true);
  });

  test("requires one exact declaration for each removed sibling path", () => {
    const baseline = packageSurface("0.2.1", [".", "./testing"]);
    const candidate = packageSurface("0.2.1", []);
    const declarations = [
      declaredBreak("OBS_PACKAGE_EXPORT_REMOVED", "0.3.0", "exports/."),
      declaredBreak(
        "OBS_PACKAGE_EXPORT_CONDITION_REMOVED",
        "0.3.0",
        "exportConditions/.:import:./dist/index.js",
      ),
      declaredBreak("OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING", "0.3.0", "runtime/."),
      declaredBreak("OBS_PACKAGE_SYMBOL_REMOVED", "0.3.0", "symbols/.:Example"),
    ];
    const findings = classifyPackageChange(baseline, candidate, "0.3.0", declarations);
    expect(
      findings
        .filter((entry) => entry.path.includes("./testing"))
        .every((entry) => entry.satisfied === false),
    ).toBe(true);
    expect(
      findings
        .filter((entry) => !entry.path.includes("./testing"))
        .every((entry) => entry.satisfied),
    ).toBe(true);
  });

  test("rejects dependency range, peer range, category and metadata changes", () => {
    const baseline = {
      ...packageSurface("0.2.1", ["."], ["vite@^6.0.0"], ["effect@^4.0.0"]),
      optionalPeers: ["vite"],
    };
    const candidate = {
      ...packageSurface("0.2.1", ["."], ["vite@^7.0.0", "effect@4.0.0"], ["effect@4.0.0"]),
      optionalPeers: [],
    };
    const findings = classifyPackageChange(baseline, candidate, "0.2.2", []);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "OBS_PACKAGE_DEPENDENCY_REMOVED",
        path: "dependencies/effect@^4.0.0",
        satisfied: false,
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "OBS_PACKAGE_DEPENDENCY_ADDED",
        path: "dependencies/effect@4.0.0",
        satisfied: true,
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "OBS_PACKAGE_PEER_CHANGED", satisfied: false }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "OBS_PACKAGE_DEPENDENCY_CATEGORY_CHANGED",
        satisfied: false,
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "OBS_PACKAGE_PEER_OPTIONALITY_CHANGED", satisfied: false }),
    );
  });

  test("accepts exact initial package releases without fetching a predecessor", () => {
    const baseline = JSON.parse(readFileSync("observability/compatibility/baseline.json", "utf8"));
    const versions = JSON.parse(
      readFileSync("observability/compatibility/candidate-versions.json", "utf8"),
    );
    const initial = packageSurface("0.3.0", ["."]);
    for (const slug of [
      "observability-evlog",
      "observability-nestjs",
      "observability-react",
      "observability-sentry",
    ]) {
      const namedInitial = { ...initial, name: `@equipe-tech/${slug}` };
      expect(
        releaseIntegrityIssue(baseline, versions, [namedInitial], `${slug}@0.3.0`),
      ).toBeUndefined();
      expect(
        releaseIntegrityIssue(
          baseline,
          versions,
          [{ ...namedInitial, version: "0.3.1" }],
          `${slug}@0.3.0`,
        ),
      ).toBe("release package does not match the exact initial candidate declaration");
    }
  });

  test("pins v0.2.1 instead of current head and wires the exact CI command", () => {
    const baseline = JSON.parse(readFileSync("observability/compatibility/baseline.json", "utf8"));
    expect(baseline.source).toEqual({
      tag: "v0.2.1",
      commit: "a5ab6997536f9d3af797429783f65c9e68a0dfa0",
    });
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("OBSERVABILITY_COMPATIBILITY_DATE=$(git show -s --format=%cs HEAD)");
    expect(workflow).toContain("- run: bun run compat");
    expect(workflow.replace("--format=%cs HEAD", "--format= HEAD")).not.toContain(
      "OBSERVABILITY_COMPATIBILITY_DATE=$(git show -s --format=%cs HEAD)",
    );
    expect(readFileSync("package.json", "utf8")).toContain(
      '"compat": "bun scripts/compatibility-gate.ts"',
    );
  });
});
