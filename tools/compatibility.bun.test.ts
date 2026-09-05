import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { browserEnvelopeMetadata } from "../packages/telemetry/src/BrowserEvents.ts";
import { Contract } from "../packages/telemetry/src/index.ts";
import { parseOperationsManifest } from "../packages/cli/src/OperationsManifest.ts";
import { encodeCompatibilityJson } from "../scripts/compatibility-json.ts";
import {
  classifyPackageChange,
  comparePeerRanges,
  declarationErrorCodes,
  evaluateContractGate,
  packageSurfaceDigest,
  inspectPackageSurface,
  PackageCompatibilityCode,
  publishedPackageSurface,
  releaseIntegrityIssue,
  versionSatisfiesBreakLane,
  type DeclaredPackageBreak,
  type PackageFinding,
  type PackageSurface,
  type PeerRangeComparison,
} from "../scripts/compatibility-gate.ts";
import { generateCompatibilityCandidate } from "../scripts/generate-compatibility-candidate.ts";
import { RegistryPackageFetchError } from "../scripts/registry-package.ts";
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
  test("emits formatter-stable compatibility artifacts across scalar array widths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "observability-compatibility-format-"));
    try {
      for (let elementLength = 1; elementLength <= 40; elementLength += 1) {
        for (let elementCount = 1; elementCount <= 20; elementCount += 1) {
          const reasonCodes = Array.from(
            { length: elementCount },
            (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(elementLength)}`,
          );
          writeFileSync(
            join(directory, `${elementLength}-${elementCount}.json`),
            await encodeCompatibilityJson({ auditActions: [{ reasonCodes }] }),
          );
        }
      }
      const formatted = Bun.spawnSync({
        cmd: ["vp", "fmt", "--check", directory],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(formatted.exitCode, formatted.stderr.toString()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("executes complete discriminating contract fixtures", () => {
    const fixtureIds = contractCompatibilityFixtures.map((fixture) => fixture.id);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect([...fixtureIds].sort()).toEqual([...Contract.CompatibilityCode.literals].sort());
    for (const fixture of contractCompatibilityFixtures) {
      const arranged = fixture.arrange();
      const report = evaluateContractGate(arranged);
      const findings = report.findings.filter((finding) => finding.code === fixture.expected.code);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: fixture.expected.code,
        path: fixture.expected.path,
        severity: fixture.expected.severity,
        aliasStatus: fixture.expected.aliasStatus,
      });
      expect(report.accepted).toBe(fixture.expected.accepted);
      expect(arranged.control).not.toEqual(arranged.baseline);
      const control = evaluateContractGate({
        baseline: arranged.baseline,
        candidate: arranged.control,
        now: arranged.now,
      });
      expect(control.findings).not.toHaveLength(0);
      expect(control.findings.some((finding) => finding.code === fixture.controlExpectedCode)).toBe(
        true,
      );
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
      expect(fixture.control).not.toEqual(fixture.baseline);
      const control = classifyPackageChange(
        fixture.baseline,
        fixture.control,
        fixture.declaredVersion,
        fixture.declaredBreaks,
      );
      expect(control).not.toHaveLength(0);
      expect(control.some((finding) => finding.code === fixture.controlExpectedCode)).toBe(true);
      expect(control.some((finding) => finding.code === fixture.expected.code)).toBe(false);
    }
  });

  test("changes classifier findings when baselines are mutated", () => {
    for (const fixture of contractCompatibilityFixtures) {
      const arranged = fixture.arrange();
      const original = evaluateContractGate(arranged).findings.find(
        (entry) => entry.code === fixture.expected.code,
      );
      const mutated = evaluateContractGate({
        baseline: {
          ...arranged.baseline,
          contractVersion: arranged.baseline.contractVersion + 1,
        },
        candidate: arranged.candidate,
        now: arranged.now,
      }).findings.find((entry) => entry.code === fixture.expected.code);
      expect(original).toBeDefined();
      expect(mutated).toBeDefined();
      expect(mutated).not.toEqual(original);
    }
    for (const fixture of packageCompatibilityFixtures) {
      const original = classifyPackageChange(
        fixture.baseline,
        fixture.candidate,
        fixture.declaredVersion,
        fixture.declaredBreaks,
      ).find((entry) => entry.code === fixture.expected.code);
      const mutated = classifyPackageChange(
        { ...fixture.baseline, version: "0.2.2" },
        fixture.candidate,
        fixture.declaredVersion,
        fixture.declaredBreaks,
      ).find((entry) => entry.code === fixture.expected.code);
      expect(original).toBeDefined();
      expect(mutated).toBeDefined();
      expect(mutated).not.toEqual(original);
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
      evaluateContractGate({
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
    expect(candidate.aliases[0].since).toBe("2026-08-31");
    expect({
      ...browserEnvelopeMetadata,
      eventFields: [...browserEnvelopeMetadata.eventFields, "drift"],
    }).not.toEqual(candidate.browserEnvelope);
  });

  test("projects all candidate metadata from a compiled contract surface", async () => {
    const contract = await Effect.runPromise(
      Contract.defineTelemetryContract({
        version: 2,
        events: {
          PaymentAttempt: {
            name: "payment.attempt",
            kind: "operation",
            defaultSeverity: "info",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {
              "payment.provider": {
                classification: "public",
                required: true,
                metricLabel: true,
              },
            },
          },
        },
        metrics: {
          PaymentLatency: {
            name: "payment.latency",
            description: "Payment latency",
            unit: "ms",
            kind: "histogram",
            boundaries: [10, 100],
            attributes: {
              "payment.provider": {
                classification: "public",
                maximumCardinality: 2,
                allowedValues: ["stripe", "adyen"],
              },
            },
          },
        },
        auditActions: {
          PaymentRefund: {
            action: "payment.refund",
            resourceType: "payment",
            allowedOutcomes: ["failure", "success"],
            reasonCodes: ["payment.duplicate"],
          },
        },
      }),
    );
    const contractSurface = Contract.contractSurface({
      contract,
      service: "checkout",
      retentionWindowDays: 30,
    });
    const candidate = JSON.parse(await generateCompatibilityCandidate({ contractSurface }));
    expect(candidate.events[0].attributes[0]).toEqual({
      name: "payment.provider",
      required: true,
      classification: "public",
      metricLabel: true,
    });
    expect(candidate.metrics[0]).toEqual(
      expect.objectContaining({
        boundaries: [10, 100],
        attributes: [
          {
            name: "payment.provider",
            classification: "public",
            maximumCardinality: 2,
            allowedValues: ["stripe", "adyen"],
          },
        ],
      }),
    );
    expect(candidate.auditActions[0]).toEqual({
      action: "payment.refund",
      resourceType: "payment",
      allowedOutcomes: ["failure", "success"],
      reasonCodes: ["payment.duplicate"],
    });
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

  test("extracts only complete public error code literals", () => {
    expect(
      declarationErrorCodes(
        'export type PublicCode = "OBS_PUBLIC_FAILURE"; export type Prefix = `OBS_CONTRACT_${string}`;',
      ),
    ).toEqual(["OBS_PUBLIC_FAILURE"]);
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

  test("validates every declared export runtime target", () => {
    const directory = mkdtempSync(join(tmpdir(), "observability-compatibility-exports-"));
    const packageRoot = join(directory, "package");
    const writeManifest = (exports: {
      readonly [name: string]:
        | string
        | {
            readonly types?: string;
            readonly import?: string;
            readonly default?: string;
          };
    }): void =>
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@equipe-tech/example",
          version: "0.2.1",
          type: "module",
          exports,
        }),
      );
    const conditionalExport = {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.default.js",
    };
    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(join(packageRoot, "dist/index.d.ts"), "export declare const example: true;\n");
      writeFileSync(join(packageRoot, "dist/index.js"), "export const example = true;\n");
      writeFileSync(join(packageRoot, "dist/index.default.js"), "export const example = true;\n");
      writeFileSync(join(packageRoot, "dist/direct.js"), "export const direct = true;\n");

      writeManifest({ ".": conditionalExport });
      const baseline = inspectPackageSurface(packageRoot);
      expect(baseline.missingRuntimeEntrypoints).toEqual([]);
      expect(baseline.surface.runtimeEntrypoints).toEqual(["."]);

      writeManifest({ ".": conditionalExport, "./direct": "./dist/direct.js" });
      const additive = inspectPackageSurface(packageRoot);
      expect(additive.missingRuntimeEntrypoints).toEqual([]);
      expect(additive.surface.runtimeEntrypoints).toEqual([".", "./direct"]);
      expect(classifyPackageChange(baseline.surface, additive.surface, "0.2.2", [])).toEqual([
        expect.objectContaining({ code: "OBS_PACKAGE_EXPORT_ADDED", satisfied: true }),
        expect.objectContaining({ code: "OBS_PACKAGE_EXPORT_CONDITION_ADDED", satisfied: true }),
      ]);

      writeManifest({ ".": conditionalExport, "./missing": "./dist/missing.js" });
      expect(inspectPackageSurface(packageRoot).missingRuntimeEntrypoints).toEqual(["./missing"]);

      writeManifest({
        ".": { ...conditionalExport, import: "./dist/missing-import.js" },
      });
      expect(inspectPackageSurface(packageRoot).missingRuntimeEntrypoints).toEqual(["."]);

      writeManifest({
        ".": { ...conditionalExport, default: "./dist/missing-default.js" },
      });
      expect(inspectPackageSurface(packageRoot).missingRuntimeEntrypoints).toEqual(["."]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies and validates published bin entrypoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "observability-compatibility-bin-"));
    const packageRoot = join(directory, "package");
    const outsideTarget = join(directory, "outside.js");
    const writeManifest = (bin: { readonly [name: string]: string }): void =>
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@equipe-tech/example",
          version: "0.2.1",
          type: "module",
          bin,
        }),
      );
    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(join(packageRoot, "dist/main.js"), "#!/usr/bin/env bun\n");
      writeFileSync(join(packageRoot, "dist/inspect.js"), "#!/usr/bin/env bun\n");
      writeFileSync(outsideTarget, "#!/usr/bin/env bun\n");
      writeManifest({ observability: "./dist/main.js" });
      const delivered = inspectPackageSurface(packageRoot);
      expect(delivered.missingRuntimeEntrypoints).toEqual([]);
      expect(delivered.surface.runtimeEntrypoints).toEqual(["bin:observability"]);

      writeManifest({ inspect: "./dist/inspect.js", observability: "./dist/main.js" });
      const additive = inspectPackageSurface(packageRoot);
      expect(additive.missingRuntimeEntrypoints).toEqual([]);
      expect(classifyPackageChange(delivered.surface, additive.surface, "0.2.2", [])).toEqual([]);

      writeManifest({});
      const removed = inspectPackageSurface(packageRoot);
      expect(classifyPackageChange(delivered.surface, removed.surface, "0.2.2", [])).toContainEqual(
        expect.objectContaining({
          code: "OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING",
          path: "runtime/bin:observability",
          satisfied: false,
        }),
      );

      writeManifest({ renamed: "./dist/main.js" });
      const renamed = inspectPackageSurface(packageRoot);
      expect(classifyPackageChange(delivered.surface, renamed.surface, "0.2.2", [])).toContainEqual(
        expect.objectContaining({ path: "runtime/bin:observability", satisfied: false }),
      );

      writeManifest({ observability: "./dist/missing.js" });
      expect(inspectPackageSurface(packageRoot).missingRuntimeEntrypoints).toEqual([
        "bin:observability",
      ]);

      writeManifest({ observability: "../outside.js" });
      expect(inspectPackageSurface(packageRoot).missingRuntimeEntrypoints).toEqual([
        "bin:observability",
      ]);

      writeFileSync(join(packageRoot, "dist/main.js"), "not an executable\n");
      writeManifest({ observability: "./dist/main.js" });
      expect(inspectPackageSurface(packageRoot).missingRuntimeEntrypoints).toEqual([
        "bin:observability",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  test("classifies semantic peer range narrowing", () => {
    const narrowingCases: ReadonlyArray<readonly [string, string]> = [
      [">=1", ">=10"],
      ["^1.0.0", "^1.0.0-beta"],
      ["^18 || ^19", "^19"],
      ["^0.0", "^0.0.0"],
    ];
    for (const [baseline, candidate] of narrowingCases) {
      expect(comparePeerRanges(baseline, candidate)).toEqual({
        baseline,
        candidate,
        classification: "narrowed",
      });
      const previous = packageSurface("1.0.0", ["."], [`react@${baseline}`]);
      const next = packageSurface("1.0.0", ["."], [`react@${candidate}`]);
      expect(classifyPackageChange(previous, next, "2.0.0", [])).toContainEqual(
        expect.objectContaining({
          code: "OBS_PACKAGE_PEER_CHANGED",
          severity: "breaking",
          satisfied: false,
        }),
      );
    }
    expect(comparePeerRanges("^19", "^18 || ^19").classification).toBe("widened");
  });

  test("preserves partial precision across the supported semver grammar", () => {
    const cases: ReadonlyArray<readonly [string, string, PeerRangeComparison["classification"]]> = [
      ["<0.0", "<0.0.0", "widened"],
      ["<=0.0", "<=0.0.0", "narrowed"],
      [">0.0", ">0.0.0", "widened"],
      [">=0.0", ">=0.0.0", "equivalent"],
      ["=0.0", "=0.0.0", "narrowed"],
      ["^0.0", "^0.0.0", "narrowed"],
      ["~0.0", "~0.0.0", "equivalent"],
      ["0.0.x", "0.0.0", "narrowed"],
      ["0.0 - 0.0", "0.0.0 - 0.0.0", "narrowed"],
      [">=1 <3", ">=1 <2", "narrowed"],
      ["^0 || ^1", "^1", "narrowed"],
      ["^1", "^0 || ^1", "widened"],
      [">=1.0.0-beta", ">=1.0.0", "narrowed"],
      ["^1.0.0-beta", "^1.0.0", "narrowed"],
      ["1.2.3+one", "1.2.3+two", "equivalent"],
    ];
    for (const [baseline, candidate, classification] of cases) {
      expect(comparePeerRanges(baseline, candidate)).toEqual({
        baseline,
        candidate,
        classification,
      });
    }
    expect(Bun.semver.satisfies("0.0.5", "<=0.0")).toBe(true);
    expect(Bun.semver.satisfies("0.0.5", "<=0.0.0")).toBe(false);
    expect(Bun.semver.satisfies("0.0.1", ">0.0")).toBe(false);
    expect(Bun.semver.satisfies("0.0.1", ">0.0.0")).toBe(true);
    expect(Bun.semver.satisfies("1.0.0-beta", ">=1.0.0-beta")).toBe(true);
    expect(Bun.semver.satisfies("1.0.0-beta", ">=1.0.0")).toBe(false);
    expect(comparePeerRanges("workspace:*", "workspace:^1").classification).toBe("narrowed");
    expect(comparePeerRanges("workspace:*", "*").classification).toBe("narrowed");
    expect(comparePeerRanges("^0.0", "workspace:*").classification).toBe("narrowed");
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

  test("matches committed baseline digests to published declaration surfaces", async () => {
    const baseline = JSON.parse(readFileSync("observability/compatibility/baseline.json", "utf8"));
    try {
      for (const historical of baseline.packages) {
        const published = await publishedPackageSurface(historical.name, historical.version);
        expect(packageSurfaceDigest(published.surface)).toBe(historical.surfaceDigest);
      }
    } catch (error) {
      if (error instanceof RegistryPackageFetchError && error.kind === "network-unavailable") {
        process.stderr.write(
          "SKIP published baseline digest check because the npm registry network is unavailable.\n",
        );
        return;
      }
      throw error;
    }
  });

  test("accepts exact initial package releases without fetching a predecessor", async () => {
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
        await releaseIntegrityIssue(baseline, versions, [namedInitial], `${slug}@0.3.0`),
      ).toBeUndefined();
      expect(
        await releaseIntegrityIssue(
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
    expect(baseline.source.tag).toBe("v0.2.1");
    expect(baseline.source.commit).toBe("a5ab6997536f9d3af797429783f65c9e68a0dfa0");
    expect(
      baseline.source.registryPackages.map((entry: { readonly name: string }) => entry.name),
    ).toEqual(["@equipe-tech/observability", "@equipe-tech/observability-cli"]);
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("OBSERVABILITY_COMPATIBILITY_DATE=$(date -u +%F)");
    expect(workflow).not.toContain("git show");
    expect(workflow).toContain("- run: bun run compat");
    expect(readFileSync("package.json", "utf8")).toContain(
      '"compat": "bun scripts/compatibility-gate.ts"',
    );
  });
});
