import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yuku-parser";

const root = fileURLToPath(new URL("..", import.meta.url));

const DependencyMap = Schema.Record(Schema.String, Schema.String);
const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
});
export const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);

type BoundaryRole = "core" | "adapter" | "bootstrap" | "domain";
type BoundaryViolation = {
  readonly rule: string;
  readonly file: string;
  readonly specifier: string;
};

type PathOwnership = {
  readonly role: BoundaryRole;
  readonly matches: (file: string) => boolean;
};

type DependencyKind = "framework" | "metric-api" | "otlp" | "provider" | "runtime-platform";

const ownership: ReadonlyArray<PathOwnership> = [
  { role: "bootstrap", matches: (file) => file === "packages/cli/src/main.ts" },
  { role: "adapter", matches: (file) => file.startsWith("packages/nestjs/src/") },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/MetricsRuntime.ts",
  },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/PolicyOtlpLogger.ts",
  },
  { role: "adapter", matches: (file) => file === "packages/telemetry/src/Telemetry.ts" },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/node/Observability.ts",
  },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/profile/LifecycleRegistry.ts",
  },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/profile/ObservabilityAdapter.ts",
  },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/testing/index.ts",
  },
  {
    role: "adapter",
    matches: (file) => file === "packages/telemetry/src/trace/HttpServerOtlpTracer.ts",
  },
  {
    role: "domain",
    matches: (file) =>
      file.startsWith("packages/cli/src/") ||
      file.startsWith("packages/telemetry/src/contract/") ||
      file.startsWith("packages/telemetry/src/policy/") ||
      file.startsWith("packages/telemetry/src/profile/"),
  },
];

export const sourceRole = (file: string): BoundaryRole => {
  for (const owner of ownership) {
    if (owner.matches(file)) return owner.role;
  }
  return "core";
};

const packageNameForSpecifier = (specifier: string): string => {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
};

const frameworkPackages = new Set([
  "@nestjs/common",
  "@nestjs/core",
  "evlog",
  "react",
  "react-dom",
  "rxjs",
]);

const forbiddenByRole = new Map<BoundaryRole, ReadonlySet<DependencyKind>>([
  ["core", new Set(["framework", "metric-api", "otlp", "provider", "runtime-platform"])],
  ["domain", new Set(["metric-api", "otlp", "provider", "runtime-platform"])],
  ["bootstrap", new Set(["framework", "provider"])],
  ["adapter", new Set()],
]);

const dependencyKind = (specifier: string): DependencyKind | undefined => {
  const dependency = packageNameForSpecifier(specifier);
  if (dependency.startsWith("@effect/platform-")) return "runtime-platform";
  if (
    specifier === "effect/Metric" ||
    specifier.startsWith("@equipe-tech/observability/metrics") ||
    dependency === "@opentelemetry/api"
  ) {
    return "metric-api";
  }
  if (
    specifier.startsWith("effect/unstable/observability") ||
    specifier.startsWith("effect/unstable/http") ||
    dependency.startsWith("@opentelemetry/")
  ) {
    return "otlp";
  }
  if (
    dependency.startsWith("@sentry/") ||
    dependency.startsWith("@axiomhq/") ||
    dependency === "axiom"
  ) {
    return "provider";
  }
  if (frameworkPackages.has(dependency)) return "framework";
  return undefined;
};

const evaluateSpecifier = (
  role: BoundaryRole,
  file: string,
  specifier: string,
): ReadonlyArray<BoundaryViolation> => {
  const kind = dependencyKind(specifier);
  if (kind === undefined || !forbiddenByRole.get(role)?.has(kind)) return [];
  return [{ rule: `boundary/${role}-forbidden-${kind}`, file, specifier }];
};

const staticImports = (source: string): ReadonlyArray<string> => {
  const program = parse(source, { lang: "ts" }).program;
  const specifiers: Array<string> = [];
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      specifiers.push(statement.source.value);
    }
    if (statement.type === "ExportNamedDeclaration" && statement.source !== null) {
      specifiers.push(statement.source.value);
    }
    if (statement.type === "ExportAllDeclaration") {
      specifiers.push(statement.source.value);
    }
    if (
      statement.type === "TSImportEqualsDeclaration" &&
      statement.moduleReference.type === "TSExternalModuleReference"
    ) {
      specifiers.push(statement.moduleReference.expression.value);
    }
  }
  return specifiers;
};

const packageDirectories = async (projectRoot: string): Promise<ReadonlyArray<string>> => {
  const directories: Array<string> = [];
  const manifests = new Bun.Glob("packages/*/package.json");
  for await (const manifest of manifests.scan({ cwd: projectRoot })) {
    directories.push(dirname(join(projectRoot, manifest)));
  }
  return directories.toSorted();
};

const declaredDependencies = (manifest: typeof PackageManifest.Type): Set<string> =>
  new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

export const checkPackageBoundaries = async (
  projectRoot: string = root,
): Promise<ReadonlyArray<BoundaryViolation>> => {
  const violations: Array<BoundaryViolation> = [];
  for (const directory of await packageDirectories(projectRoot)) {
    const manifestValue: unknown = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const manifest = decodePackageManifest(manifestValue);
    const declared = declaredDependencies(manifest);
    const sources = new Bun.Glob("src/**/*.ts");
    for await (const sourcePath of sources.scan({ cwd: directory })) {
      const absolute = join(directory, sourcePath);
      const file = relative(projectRoot, absolute).split(sep).join("/");
      const source = await readFile(absolute, "utf8");
      for (const specifier of staticImports(source)) {
        violations.push(...evaluateSpecifier(sourceRole(file), file, specifier));
        const dependency = packageNameForSpecifier(specifier);
        if (
          !specifier.startsWith(".") &&
          !specifier.startsWith("node:") &&
          dependency !== manifest.name &&
          !declared.has(dependency)
        ) {
          violations.push({ rule: "boundary/undeclared-dependency", file, specifier });
        }
      }
    }
  }
  return violations;
};
