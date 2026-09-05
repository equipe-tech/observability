import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { Range, validRange } from "semver";
import { compareParsedPeerRanges } from "./peer-range-coverage.ts";
import { Contract } from "../packages/telemetry/src/index.ts";
import { decodeCompatibilityJson } from "./compatibility-json.ts";
import { generateCompatibilityCandidate } from "./generate-compatibility-candidate.ts";
import { fetchRegistryPackage } from "./registry-package.ts";

const ExportTarget = Schema.Union([
  Schema.String,
  Schema.Struct({
    types: Schema.String.pipe(Schema.optionalKey),
    import: Schema.String.pipe(Schema.optionalKey),
    default: Schema.String.pipe(Schema.optionalKey),
  }),
]);
const StringEntries = Schema.Record(Schema.String, Schema.String);
const PackageDocument = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  type: Schema.String,
  exports: Schema.Record(Schema.String, ExportTarget).pipe(Schema.optionalKey),
  bin: Schema.Record(Schema.String, Schema.String).pipe(Schema.optionalKey),
  dependencies: StringEntries.pipe(Schema.optionalKey),
  peerDependencies: StringEntries.pipe(Schema.optionalKey),
  peerDependenciesMeta: Schema.Record(
    Schema.String,
    Schema.Struct({ optional: Schema.Boolean.pipe(Schema.optionalKey) }),
  ).pipe(Schema.optionalKey),
});
const PackageSurfaceDocument = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  surfaceDigest: Schema.String.pipe(Schema.optionalKey),
  type: Schema.String,
  exports: Schema.Array(Schema.String),
  exportConditions: Schema.Array(Schema.String),
  runtimeEntrypoints: Schema.Array(Schema.String),
  declarationSymbols: Schema.Array(Schema.String),
  dependencies: Schema.Array(Schema.String),
  peerDependencies: Schema.Array(Schema.String),
  optionalPeers: Schema.Array(Schema.String),
  publicErrorCodes: Schema.Array(Schema.String),
});
export const PackageCompatibilityCode = Schema.Literals([
  "OBS_PACKAGE_EXPORT_ADDED",
  "OBS_PACKAGE_EXPORT_REMOVED",
  "OBS_PACKAGE_SYMBOL_ADDED",
  "OBS_PACKAGE_SYMBOL_REMOVED",
  "OBS_PACKAGE_DEPENDENCY_ADDED",
  "OBS_PACKAGE_DEPENDENCY_REMOVED",
  "OBS_PACKAGE_DEPENDENCY_CATEGORY_CHANGED",
  "OBS_PACKAGE_PEER_ADDED",
  "OBS_PACKAGE_PEER_WIDENED",
  "OBS_PACKAGE_PEER_CHANGED",
  "OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING",
  "OBS_PACKAGE_NAME_CHANGED",
  "OBS_PACKAGE_TYPE_CHANGED",
  "OBS_PACKAGE_EXPORT_CONDITION_ADDED",
  "OBS_PACKAGE_EXPORT_CONDITION_REMOVED",
  "OBS_PACKAGE_PEER_OPTIONALITY_CHANGED",
  "OBS_PACKAGE_ERROR_CODE_ADDED",
  "OBS_PACKAGE_ERROR_CODE_REMOVED",
]);

export type PackageCompatibilityCode = typeof PackageCompatibilityCode.Type;

const BaselineDocument = Schema.Struct({
  baseline: Schema.Literal(1),
  source: Schema.Struct({
    tag: Schema.String,
    commit: Schema.String,
    registryPackages: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        version: Schema.String,
        tarball: Schema.String,
        integrity: Schema.String,
      }),
    ),
  }),
  contract: Contract.ContractSurfaceSchema,
  packages: Schema.Array(PackageSurfaceDocument),
});
const CandidateVersionsDocument = Schema.Struct({
  version: Schema.Literal(1),
  packages: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String })),
});
const DeclaredBreaksDocument = Schema.Struct({
  version: Schema.Literal(1),
  breaks: Schema.Array(
    Schema.Struct({
      scope: Schema.Literal("package"),
      package: Schema.String,
      code: PackageCompatibilityCode,
      path: Schema.String,
      candidateVersion: Schema.String,
      migrationGuide: Schema.String,
    }),
  ),
});
const decodePackage = Schema.decodeUnknownSync(PackageDocument, { onExcessProperty: "preserve" });
const decodeBaseline = Schema.decodeUnknownSync(BaselineDocument, { onExcessProperty: "error" });
const decodeVersions = Schema.decodeUnknownSync(CandidateVersionsDocument, {
  onExcessProperty: "error",
});
const decodeBreaks = Schema.decodeUnknownSync(DeclaredBreaksDocument, {
  onExcessProperty: "error",
});

export type CompatibilityBaselineArtifact = typeof BaselineDocument.Type;
export type DeclaredPackageBreak = (typeof DeclaredBreaksDocument.Type)["breaks"][number];

export type PackageFinding = {
  readonly package: string;
  readonly code: PackageCompatibilityCode;
  readonly path: string;
  readonly severity: "compatible" | "breaking";
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly declaredVersion: string;
  readonly satisfied: boolean;
};

export type PackageSurface = typeof PackageSurfaceDocument.Type;
export type PackageSurfaceInspection = {
  readonly surface: PackageSurface;
  readonly missingRuntimeEntrypoints: ReadonlyArray<string>;
};
export type ContractGateResult = Contract.CompatibilityReport;
type ExportEntry = readonly [string, typeof ExportTarget.Type];
type RuntimeEntrypoint = {
  readonly name: string;
  readonly target: string;
  readonly executable: boolean;
};

const parseJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const pairs = (entries: { readonly [key: string]: string } | undefined): ReadonlyArray<string> =>
  Object.entries(entries ?? {})
    .map(([name, value]) => `${name}@${value}`)
    .sort();
const exportEntries = (document: typeof PackageDocument.Type): ReadonlyArray<ExportEntry> =>
  Object.entries(document.exports ?? {}).sort((left, right) => left[0].localeCompare(right[0]));
const exportTypesPath = (target: typeof ExportTarget.Type): string | undefined =>
  target instanceof Object && "types" in target ? target.types : undefined;
const exportRuntimePaths = (target: typeof ExportTarget.Type): ReadonlyArray<string> =>
  target instanceof Object
    ? Object.entries(target).flatMap(([condition, path]) => (condition === "types" ? [] : [path]))
    : [target];
const exportConditions = (document: typeof PackageDocument.Type): ReadonlyArray<string> =>
  exportEntries(document)
    .flatMap(([name, target]) =>
      target instanceof Object
        ? Object.entries(target).map(([condition, path]) => `${name}:${condition}:${path}`)
        : [`${name}:default:${target}`],
    )
    .sort();

const declarationSymbols = (
  packageRoot: string,
  document: typeof PackageDocument.Type,
): ReadonlyArray<string> => {
  const symbols = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string, exportName: string): void => {
    const visitKey = `${exportName}\u0000${path}`;
    if (visited.has(visitKey) || !existsSync(path)) return;
    visited.add(visitKey);
    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(
      /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    )) {
      const name = match[1];
      if (name !== undefined) symbols.add(`${exportName}:${name}`);
    }
    for (const match of content.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const name = match[1];
      if (name !== undefined) symbols.add(`${exportName}:${name}`);
    }
    for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
      const members = match[1];
      if (members === undefined) continue;
      for (const member of members.split(",")) {
        const name = member
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim();
        if (name !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
          symbols.add(`${exportName}:${name}`);
      }
    }
    for (const match of content.matchAll(/export\s+(?:\*|\{[^}]+\})\s+from\s+["']([^"']+)["']/g)) {
      const reference = match[1];
      if (reference === undefined || !reference.startsWith(".")) continue;
      const resolved = join(dirname(path), reference.replace(/[.]js$/, ".d.ts"));
      visit(
        existsSync(resolved) ? resolved : join(resolved.replace(/[.]d[.]ts$/, ""), "index.d.ts"),
        exportName,
      );
    }
  };
  for (const [exportName, target] of exportEntries(document)) {
    const typesPath = exportTypesPath(target);
    if (typesPath !== undefined) visit(join(packageRoot, typesPath), exportName);
  }
  return [...symbols].sort();
};

const exportedDeclarationText = (
  packageRoot: string,
  document: typeof PackageDocument.Type,
): string => {
  const visited = new Set<string>();
  const contents: Array<string> = [];
  const visit = (path: string): void => {
    if (visited.has(path) || !existsSync(path)) return;
    visited.add(path);
    const content = readFileSync(path, "utf8");
    contents.push(content);
    for (const match of content.matchAll(/export\s+(?:\*|\{[^}]+\})\s+from\s+["']([^"']+)["']/g)) {
      const reference = match[1];
      if (reference === undefined || !reference.startsWith(".")) continue;
      const resolved = join(dirname(path), reference.replace(/[.]js$/, ".d.ts"));
      visit(
        existsSync(resolved) ? resolved : join(resolved.replace(/[.]d[.]ts$/, ""), "index.d.ts"),
      );
    }
  };
  for (const [, target] of exportEntries(document)) {
    const path = exportTypesPath(target);
    if (path !== undefined) visit(join(packageRoot, path));
  }
  return contents.join("\n");
};

export const declarationErrorCodes = (declarationText: string): ReadonlyArray<string> =>
  [
    ...new Set(
      [...declarationText.matchAll(/["'](OBS_[A-Z0-9_]+)["']/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  ].sort();

const runtimeEntrypointDeclarations = (
  document: typeof PackageDocument.Type,
): ReadonlyArray<RuntimeEntrypoint> => [
  ...exportEntries(document).flatMap(([name, target]) =>
    exportRuntimePaths(target).map((path) => ({ name, target: path, executable: false })),
  ),
  ...Object.entries(document.bin ?? {}).map(([name, target]) => ({
    name: `bin:${name}`,
    target,
    executable: true,
  })),
];

const runtimeEntrypointDelivered = (
  packageRoot: string,
  entrypoint: RuntimeEntrypoint,
): boolean => {
  if (!entrypoint.target.startsWith("./")) return false;
  const root = resolve(packageRoot);
  const target = resolve(root, entrypoint.target);
  const packageRelativeTarget = relative(root, target);
  if (
    packageRelativeTarget === "" ||
    packageRelativeTarget === ".." ||
    packageRelativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(packageRelativeTarget)
  )
    return false;
  try {
    if (!statSync(target).isFile()) return false;
    return !entrypoint.executable || readFileSync(target, "utf8").startsWith("#!");
  } catch {
    return false;
  }
};

export const inspectPackageSurface = (packageRoot: string): PackageSurfaceInspection => {
  const document = decodePackage(parseJson(join(packageRoot, "package.json")));
  const exports = exportEntries(document).map((entry) => entry[0]);
  const declarations = runtimeEntrypointDeclarations(document);
  const runtimeEntrypoints = [
    ...new Set(
      declarations
        .filter((entry) => runtimeEntrypointDelivered(packageRoot, entry))
        .map((entry) => entry.name),
    ),
  ].sort();
  const optionalPeers = Object.entries(document.peerDependenciesMeta ?? {})
    .filter((entry) => entry[1].optional === true)
    .map((entry) => entry[0])
    .sort();
  const symbols = declarationSymbols(packageRoot, document);
  const declarationText = exportedDeclarationText(packageRoot, document);
  const publicErrorCodes = declarationErrorCodes(declarationText);
  return {
    surface: {
      name: document.name,
      version: document.version,
      type: document.type,
      exports,
      exportConditions: exportConditions(document),
      runtimeEntrypoints,
      declarationSymbols: symbols,
      dependencies: pairs(document.dependencies),
      peerDependencies: pairs(document.peerDependencies),
      optionalPeers,
      publicErrorCodes,
    },
    missingRuntimeEntrypoints: [
      ...new Set(
        declarations
          .filter((entry) => !runtimeEntrypointDelivered(packageRoot, entry))
          .map((entry) => entry.name),
      ),
    ].sort(),
  };
};

export const currentPackageSurface = (packageRoot: string): PackageSurface =>
  inspectPackageSurface(packageRoot).surface;

const semver = (version: string): readonly [number, number, number] | undefined => {
  const match = /^(0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/.exec(version);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch)
    ? [major, minor, patch]
    : undefined;
};
const versionGreater = (baseline: string, candidate: string): boolean => {
  const previous = semver(baseline);
  const next = semver(candidate);
  if (previous === undefined || next === undefined) return false;
  return (
    next[0] > previous[0] ||
    (next[0] === previous[0] && next[1] > previous[1]) ||
    (next[0] === previous[0] && next[1] === previous[1] && next[2] > previous[2])
  );
};
export const versionSatisfiesBreakLane = (baseline: string, candidate: string): boolean => {
  const previous = semver(baseline);
  const next = semver(candidate);
  if (previous === undefined || next === undefined) return false;
  return previous[0] === 0
    ? next[0] > previous[0] || (next[0] === 0 && next[1] > previous[1])
    : next[0] > previous[0];
};

type SetChange = {
  readonly code: PackageCompatibilityCode;
  readonly path: string;
  readonly severity: "compatible" | "breaking";
};
const setChange = (
  code: PackageCompatibilityCode,
  path: string,
  severity: SetChange["severity"],
): SetChange => ({ code, path, severity });
export type PeerRangeComparison = {
  readonly baseline: string;
  readonly candidate: string;
  readonly classification: "equivalent" | "widened" | "narrowed";
};

const dependencyEntry = (entry: string): { readonly name: string; readonly range: string } => {
  const separator = entry.lastIndexOf("@");
  return { name: entry.slice(0, separator), range: entry.slice(separator + 1) };
};

export const comparePeerRanges = (baseline: string, candidate: string): PeerRangeComparison => {
  if (baseline === candidate) return { baseline, candidate, classification: "equivalent" };
  if (validRange(baseline) === null || validRange(candidate) === null)
    return { baseline, candidate, classification: "narrowed" };
  return {
    baseline,
    candidate,
    classification: compareParsedPeerRanges(new Range(baseline), new Range(candidate)),
  };
};

const comparePeers = (
  baseline: ReadonlyArray<string>,
  candidate: ReadonlyArray<string>,
): ReadonlyArray<SetChange> => {
  const previous = new Map(
    baseline.map((entry) => {
      const parsed = dependencyEntry(entry);
      return [parsed.name, parsed.range];
    }),
  );
  const next = new Map(
    candidate.map((entry) => {
      const parsed = dependencyEntry(entry);
      return [parsed.name, parsed.range];
    }),
  );
  const changes: Array<SetChange> = [];
  for (const [name, range] of next) {
    const oldRange = previous.get(name);
    if (oldRange === undefined) {
      changes.push(
        setChange("OBS_PACKAGE_PEER_ADDED", `peerDependencies/${name}@${range}`, "compatible"),
      );
    } else if (oldRange !== range) {
      const comparison = comparePeerRanges(oldRange, range);
      if (comparison.classification === "widened")
        changes.push(
          setChange(
            "OBS_PACKAGE_PEER_WIDENED",
            `peerDependencies/${name}@${oldRange}->${range}`,
            "compatible",
          ),
        );
      if (comparison.classification === "narrowed")
        changes.push(
          setChange(
            "OBS_PACKAGE_PEER_CHANGED",
            `peerDependencies/${name}@${oldRange}->${range}`,
            "breaking",
          ),
        );
    }
  }
  for (const [name, range] of previous) {
    if (!next.has(name))
      changes.push(
        setChange("OBS_PACKAGE_PEER_CHANGED", `peerDependencies/${name}@${range}`, "breaking"),
      );
  }
  return changes;
};
const sameStringSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
};
const compareSet = (
  baseline: ReadonlyArray<string>,
  candidate: ReadonlyArray<string>,
  addedCode: PackageCompatibilityCode,
  removedCode: PackageCompatibilityCode,
  prefix: string,
): ReadonlyArray<SetChange> => {
  const previous = new Set(baseline);
  const next = new Set(candidate);
  return [
    ...candidate
      .filter((value) => !previous.has(value))
      .map((value) => setChange(addedCode, `${prefix}/${value}`, "compatible")),
    ...baseline
      .filter((value) => !next.has(value))
      .map((value) => setChange(removedCode, `${prefix}/${value}`, "breaking")),
  ];
};

export const classifyPackageChange = (
  baseline: PackageSurface,
  candidate: PackageSurface,
  declaredVersion: string,
  declaredBreaks: ReadonlyArray<DeclaredPackageBreak>,
): ReadonlyArray<PackageFinding> => {
  const raw: Array<SetChange> = [
    ...compareSet(
      baseline.exports,
      candidate.exports,
      "OBS_PACKAGE_EXPORT_ADDED",
      "OBS_PACKAGE_EXPORT_REMOVED",
      "exports",
    ),
    ...compareSet(
      baseline.exportConditions,
      candidate.exportConditions,
      "OBS_PACKAGE_EXPORT_CONDITION_ADDED",
      "OBS_PACKAGE_EXPORT_CONDITION_REMOVED",
      "exportConditions",
    ),
    ...compareSet(
      baseline.declarationSymbols,
      candidate.declarationSymbols,
      "OBS_PACKAGE_SYMBOL_ADDED",
      "OBS_PACKAGE_SYMBOL_REMOVED",
      "symbols",
    ),
    ...compareSet(
      baseline.dependencies,
      candidate.dependencies,
      "OBS_PACKAGE_DEPENDENCY_ADDED",
      "OBS_PACKAGE_DEPENDENCY_REMOVED",
      "dependencies",
    ),
    ...comparePeers(baseline.peerDependencies, candidate.peerDependencies),
    ...compareSet(
      baseline.publicErrorCodes,
      candidate.publicErrorCodes,
      "OBS_PACKAGE_ERROR_CODE_ADDED",
      "OBS_PACKAGE_ERROR_CODE_REMOVED",
      "publicErrorCodes",
    ),
    ...baseline.runtimeEntrypoints
      .filter((entry) => !candidate.runtimeEntrypoints.includes(entry))
      .map((entry) =>
        setChange("OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING", `runtime/${entry}`, "breaking"),
      ),
  ];
  if (baseline.name !== candidate.name)
    raw.push(setChange("OBS_PACKAGE_NAME_CHANGED", "name", "breaking"));
  if (baseline.type !== candidate.type)
    raw.push(setChange("OBS_PACKAGE_TYPE_CHANGED", "type", "breaking"));
  if (!sameStringSet(baseline.optionalPeers, candidate.optionalPeers))
    raw.push(setChange("OBS_PACKAGE_PEER_OPTIONALITY_CHANGED", "peerDependenciesMeta", "breaking"));
  const baselineDependencyNames = new Set(
    baseline.dependencies.map((entry) => entry.slice(0, entry.lastIndexOf("@"))),
  );
  const candidatePeerNames = new Set(
    candidate.peerDependencies.map((entry) => entry.slice(0, entry.lastIndexOf("@"))),
  );
  for (const name of baselineDependencyNames) {
    if (candidatePeerNames.has(name))
      raw.push(
        setChange("OBS_PACKAGE_DEPENDENCY_CATEGORY_CHANGED", `dependencies/${name}`, "breaking"),
      );
  }
  return raw.map((entry) => {
    const declared = declaredBreaks.some(
      (item) =>
        item.package === candidate.name &&
        item.code === entry.code &&
        item.path === entry.path &&
        item.candidateVersion === declaredVersion &&
        existsSync(item.migrationGuide),
    );
    return {
      package: candidate.name,
      code: entry.code,
      path: entry.path,
      severity: entry.severity,
      baselineVersion: baseline.version,
      candidateVersion: candidate.version,
      declaredVersion,
      satisfied:
        entry.severity === "compatible"
          ? versionGreater(baseline.version, declaredVersion)
          : declared && versionSatisfiesBreakLane(baseline.version, declaredVersion),
    };
  });
};

export const packageSurfaceDigest = (surface: PackageSurface): string =>
  createHash("sha256").update(JSON.stringify(surface)).digest("hex");

export const publishedPackageSurface = async (
  name: string,
  version: string,
): Promise<{
  readonly artifact: CompatibilityBaselineArtifact["source"]["registryPackages"][number];
  readonly surface: PackageSurface;
}> => {
  const directory = mkdtempSync(join(tmpdir(), "observability-registry-package-"));
  try {
    const artifact = await fetchRegistryPackage({ name, version }, directory);
    return { artifact, surface: currentPackageSurface(directory) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export const releaseIntegrityIssue = async (
  baseline: CompatibilityBaselineArtifact,
  versions: typeof CandidateVersionsDocument.Type,
  currentPackages: ReadonlyArray<PackageSurface>,
  release: string | undefined,
): Promise<string | undefined> => {
  if (release === undefined) return undefined;
  const separator = release?.lastIndexOf("@") ?? -1;
  if (release === undefined || separator <= 0) return "release argument is malformed";
  const slug = release.slice(0, separator);
  const version = release.slice(separator + 1);
  const packageName = `@equipe-tech/${slug}`;
  const declaredVersion = versions.packages.find((entry) => entry.name === packageName)?.version;
  const previous = baseline.packages.find((entry) => entry.name === packageName);
  if (declaredVersion !== version)
    return "release version does not match the candidate declaration";
  const current = currentPackages.find((entry) => entry.name === packageName);
  if (current === undefined || current.version !== version)
    return "release package does not match the exact initial candidate declaration";
  if (previous === undefined) return undefined;
  if (previous.surfaceDigest === undefined)
    return "release baseline has no canonical package surface digest";
  try {
    const published = await publishedPackageSurface(packageName, previous.version);
    return packageSurfaceDigest(published.surface) === previous.surfaceDigest
      ? undefined
      : "prior npm package surface differs from the tagged baseline";
  } catch {
    return "prior npm tarball could not be fetched or safely extracted";
  }
};

export const evaluateContractGate = (
  input: Contract.ContractCompatibilityInput,
): ContractGateResult => Contract.classifyContractChange(input);

const missingPackageFinding = (
  previous: PackageSurface,
  declaredVersion: string | undefined,
): PackageFinding => ({
  package: previous.name,
  code: "OBS_PACKAGE_NAME_CHANGED",
  path: "name",
  severity: "breaking",
  baselineVersion: previous.version,
  candidateVersion: "missing",
  declaredVersion: declaredVersion ?? "missing",
  satisfied: false,
});

export const runCompatibilityGate = async (): Promise<boolean> => {
  const baseline = decodeBaseline(parseJson("observability/compatibility/baseline.json"));
  const versions = decodeVersions(parseJson("observability/compatibility/candidate-versions.json"));
  const declaredBreaks = decodeBreaks(
    parseJson("observability/compatibility/declared-breaks.json"),
  );
  const baselineContract = baseline.contract;
  const committedCandidate = readFileSync("observability/compatibility/candidate.json", "utf8");
  const generatedCandidate = await generateCompatibilityCandidate();
  const candidateDrift =
    committedCandidate === generatedCandidate
      ? undefined
      : "candidate.json differs from the generated contract surface";
  const candidateContract = await Effect.runPromise(decodeCompatibilityJson(generatedCandidate));
  const contractReport = evaluateContractGate({
    baseline: baselineContract,
    candidate: candidateContract,
    now: process.env.OBSERVABILITY_COMPATIBILITY_DATE ?? new Date().toISOString().slice(0, 10),
  });
  const packageRoots = readdirSync("packages", { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join("packages", entry.name, "package.json")),
    )
    .map((entry) => join("packages", entry.name));
  const packageInspections = packageRoots.map(inspectPackageSurface);
  const currentPackages = packageInspections.map((inspection) => inspection.surface);
  const packageReports = baseline.packages.flatMap((previous) => {
    const candidate = currentPackages.find((entry) => entry.name === previous.name);
    const declaredVersion = versions.packages.find(
      (entry) => entry.name === previous.name,
    )?.version;
    if (candidate === undefined || declaredVersion === undefined)
      return [missingPackageFinding(previous, declaredVersion)];
    return classifyPackageChange(previous, candidate, declaredVersion, declaredBreaks.breaks);
  });
  const initialPackages = currentPackages
    .filter((candidate) => !baseline.packages.some((previous) => previous.name === candidate.name))
    .map((candidate) => ({
      name: candidate.name,
      declaredVersion:
        versions.packages.find((entry) => entry.name === candidate.name)?.version ?? "missing",
      exports: candidate.exports,
      exportConditions: candidate.exportConditions,
      declarationSymbols: candidate.declarationSymbols,
    }));
  const missingCandidateVersions = currentPackages
    .filter(
      (candidate) => versions.packages.find((entry) => entry.name === candidate.name) === undefined,
    )
    .map((candidate) => candidate.name);
  const missingRuntime = packageInspections.flatMap((inspection) =>
    inspection.missingRuntimeEntrypoints.map((entry) => `${inspection.surface.name}:${entry}`),
  );
  const releaseIndex = process.argv.indexOf("--release");
  const release = releaseIndex < 0 ? undefined : process.argv[releaseIndex + 1];
  const integrityIssue = await releaseIntegrityIssue(baseline, versions, currentPackages, release);
  const accepted =
    contractReport.accepted &&
    packageReports.every((entry) => entry.satisfied) &&
    missingRuntime.length === 0 &&
    missingCandidateVersions.length === 0 &&
    integrityIssue === undefined &&
    candidateDrift === undefined;
  const report = {
    report: 1,
    accepted,
    baseline: baseline.source,
    contract: JSON.parse(Contract.encodeCompatibilityReport(contractReport)),
    candidateDrift: candidateDrift ?? "none",
    packages: packageReports.sort((left, right) =>
      `${left.package}\u0000${left.path}\u0000${left.code}`.localeCompare(
        `${right.package}\u0000${right.path}\u0000${right.code}`,
      ),
    ),
    initialPackages,
    missingCandidateVersions,
    missingRuntime: missingRuntime.sort(),
    releaseIntegrity: integrityIssue ?? (release === undefined ? "not-required" : "verified"),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return accepted;
};

if (import.meta.main && !(await runCompatibilityGate())) process.exitCode = 1;
