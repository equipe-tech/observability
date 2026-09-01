import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { Contract } from "../packages/telemetry/src/index.ts";

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
  integrity: Schema.String.pipe(Schema.optionalKey),
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
const BaselineDocument = Schema.Struct({
  baseline: Schema.Literal(1),
  source: Schema.Struct({ tag: Schema.String, commit: Schema.String }),
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
      code: Schema.String,
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

export type PackageCompatibilityCode =
  | "OBS_PACKAGE_EXPORT_ADDED"
  | "OBS_PACKAGE_EXPORT_REMOVED"
  | "OBS_PACKAGE_SYMBOL_ADDED"
  | "OBS_PACKAGE_SYMBOL_REMOVED"
  | "OBS_PACKAGE_DEPENDENCY_ADDED"
  | "OBS_PACKAGE_DEPENDENCY_REMOVED"
  | "OBS_PACKAGE_DEPENDENCY_CATEGORY_CHANGED"
  | "OBS_PACKAGE_PEER_ADDED"
  | "OBS_PACKAGE_PEER_CHANGED"
  | "OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING"
  | "OBS_PACKAGE_NAME_CHANGED"
  | "OBS_PACKAGE_TYPE_CHANGED"
  | "OBS_PACKAGE_EXPORT_CONDITION_ADDED"
  | "OBS_PACKAGE_EXPORT_CONDITION_REMOVED"
  | "OBS_PACKAGE_PEER_OPTIONALITY_CHANGED"
  | "OBS_PACKAGE_ERROR_CODE_ADDED"
  | "OBS_PACKAGE_ERROR_CODE_REMOVED";

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
type ExportEntry = readonly [string, typeof ExportTarget.Type];

const parseJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const pairs = (entries: { readonly [key: string]: string } | undefined): ReadonlyArray<string> =>
  Object.entries(entries ?? {})
    .map(([name, value]) => `${name}@${value}`)
    .sort();
const exportEntries = (document: typeof PackageDocument.Type): ReadonlyArray<ExportEntry> =>
  Object.entries(document.exports ?? {}).sort((left, right) => left[0].localeCompare(right[0]));
const exportTypesPath = (target: typeof ExportTarget.Type): string | undefined =>
  target instanceof Object && "types" in target ? target.types : undefined;
const exportRuntimePath = (target: typeof ExportTarget.Type): string | undefined =>
  target instanceof Object && "import" in target ? target.import : undefined;
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
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim();
        if (name !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
          symbols.add(`${exportName}:${name}`);
      }
    }
    for (const match of content.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
      const reference = match[1];
      if (reference === undefined || !reference.startsWith(".")) continue;
      const resolved = join(dirname(path), reference.replace(/[.]js$/, ".d.ts"));
      visit(resolved, exportName);
    }
  };
  for (const [exportName, target] of exportEntries(document)) {
    const typesPath = exportTypesPath(target);
    if (typesPath !== undefined) visit(join(packageRoot, typesPath), exportName);
  }
  return [...symbols].sort();
};

const currentPackageSurface = (packageRoot: string): PackageSurface => {
  const document = decodePackage(parseJson(join(packageRoot, "package.json")));
  const exports = exportEntries(document).map((entry) => entry[0]);
  const runtimeEntrypoints = exportEntries(document)
    .filter((entry) => {
      const path = exportRuntimePath(entry[1]);
      return path !== undefined && existsSync(join(packageRoot, path));
    })
    .map((entry) => entry[0]);
  const optionalPeers = Object.entries(document.peerDependenciesMeta ?? {})
    .filter((entry) => entry[1].optional === true)
    .map((entry) => entry[0])
    .sort();
  const symbols = declarationSymbols(packageRoot, document);
  const declarationText = exportEntries(document)
    .flatMap((entry) => {
      const path = exportTypesPath(entry[1]);
      return path !== undefined && existsSync(join(packageRoot, path))
        ? [readFileSync(join(packageRoot, path), "utf8")]
        : [];
    })
    .join("\n");
  const publicErrorCodes = [...new Set(declarationText.match(/OBS_[A-Z0-9_]+/g) ?? [])].sort();
  return {
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
  };
};

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
const dependencyEntry = (entry: string): { readonly name: string; readonly range: string } => {
  const separator = entry.lastIndexOf("@");
  return { name: entry.slice(0, separator), range: entry.slice(separator + 1) };
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
      changes.push(
        setChange(
          oldRange.split("||").every((part) => range.includes(part.trim()))
            ? "OBS_PACKAGE_PEER_ADDED"
            : "OBS_PACKAGE_PEER_CHANGED",
          `peerDependencies/${name}@${oldRange}->${range}`,
          oldRange.split("||").every((part) => range.includes(part.trim()))
            ? "compatible"
            : "breaking",
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
    ...baseline.exports
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

const releaseIntegrityIssue = (
  baseline: typeof BaselineDocument.Type,
  versions: typeof CandidateVersionsDocument.Type,
): string | undefined => {
  const releaseIndex = process.argv.indexOf("--release");
  if (releaseIndex < 0) return undefined;
  const release = process.argv[releaseIndex + 1];
  const separator = release?.lastIndexOf("@") ?? -1;
  if (release === undefined || separator <= 0) return "release argument is malformed";
  const slug = release.slice(0, separator);
  const version = release.slice(separator + 1);
  const packageName = `@equipe-tech/${slug}`;
  const declaredVersion = versions.packages.find((entry) => entry.name === packageName)?.version;
  const previous = baseline.packages.find((entry) => entry.name === packageName);
  if (declaredVersion !== version)
    return "release version does not match the candidate declaration";
  if (previous === undefined || previous.integrity === undefined)
    return "release baseline has no package integrity evidence";
  const directory = mkdtempSync(join(tmpdir(), "observability-compatibility-"));
  try {
    const packed = Bun.spawnSync({
      cmd: [
        "bunx",
        "npm",
        "pack",
        `${packageName}@${previous.version}`,
        "--pack-destination",
        directory,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (packed.exitCode !== 0) return "prior npm tarball could not be fetched";
    const filename = packed.stdout.toString().trim().split("\n").at(-1);
    if (filename === undefined || !existsSync(join(directory, filename)))
      return "prior npm tarball was not produced";
    const checksum = createHash("sha256")
      .update(readFileSync(join(directory, filename)))
      .digest("hex");
    return checksum === previous.integrity
      ? undefined
      : "prior npm tarball checksum differs from the tagged archive";
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

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
  const baselineContract = await Effect.runPromise(
    Contract.decodeContractSurface(`${JSON.stringify(baseline.contract)}\n`),
  );
  const candidateContract = await Effect.runPromise(
    Contract.decodeContractSurface(
      readFileSync("observability/compatibility/candidate.json", "utf8"),
    ),
  );
  const contractReport = Contract.classifyContractChange({
    baseline: baselineContract,
    candidate: candidateContract,
    now: process.env.OBSERVABILITY_COMPATIBILITY_DATE ?? new Date().toISOString().slice(0, 10),
  });
  const packageRoots = readdirSync("packages", { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join("packages", entry.name, "package.json")),
    )
    .map((entry) => join("packages", entry.name));
  const currentPackages = packageRoots.map(currentPackageSurface);
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
  const missingRuntime = currentPackages.flatMap((candidate) =>
    candidate.exports
      .filter(
        (entry) => !candidate.runtimeEntrypoints.includes(entry) && entry !== "./package.json",
      )
      .map((entry) => `${candidate.name}:${entry}`),
  );
  const integrityIssue = releaseIntegrityIssue(baseline, versions);
  const accepted =
    contractReport.accepted &&
    packageReports.every((entry) => entry.satisfied) &&
    missingRuntime.length === 0 &&
    missingCandidateVersions.length === 0 &&
    integrityIssue === undefined;
  const report = {
    report: 1,
    accepted,
    baseline: baseline.source,
    contract: contractReport,
    packages: packageReports.sort((left, right) =>
      `${left.package}\u0000${left.path}\u0000${left.code}`.localeCompare(
        `${right.package}\u0000${right.path}\u0000${right.code}`,
      ),
    ),
    initialPackages,
    missingCandidateVersions,
    missingRuntime: missingRuntime.sort(),
    releaseIntegrity: integrityIssue ?? "not-required-or-verified",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return accepted;
};

if (import.meta.main && !(await runCompatibilityGate())) process.exitCode = 1;
