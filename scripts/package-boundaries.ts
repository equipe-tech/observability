import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const DependencyMap = Schema.Record(Schema.String, Schema.String);
export const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
});
export const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);

export type BoundaryRole = "core" | "adapter" | "bootstrap" | "domain";
export type BoundaryViolation = {
  readonly rule: string;
  readonly file: string;
  readonly specifier: string;
};

type PathOwnership = {
  readonly role: BoundaryRole;
  readonly matches: (file: string) => boolean;
};

const exactPaths = new Set([
  "packages/cli/src/main.ts",
  "packages/nestjs/src/TelemetryModule.ts",
  "packages/telemetry/src/node/Observability.ts",
]);

const adapterPaths = new Set([
  "packages/cli/src/ProviderApis.ts",
  "packages/telemetry/src/MetricsRuntime.ts",
  "packages/telemetry/src/PolicyOtlpLogger.ts",
  "packages/telemetry/src/Telemetry.ts",
  "packages/telemetry/src/profile/LifecycleRegistry.ts",
  "packages/telemetry/src/profile/ObservabilityAdapter.ts",
]);

const ownership: ReadonlyArray<PathOwnership> = [
  { role: "bootstrap", matches: (file) => exactPaths.has(file) },
  {
    role: "adapter",
    matches: (file) =>
      adapterPaths.has(file) ||
      file.startsWith("packages/nestjs/src/") ||
      file.startsWith("packages/telemetry/src/browser/") ||
      file.startsWith("packages/telemetry/src/node/") ||
      file.startsWith("packages/telemetry/src/testing/") ||
      file.startsWith("packages/telemetry/src/trace/"),
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

export const packageNameForSpecifier = (specifier: string): string => {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
};

const forbiddenCorePackages = new Set([
  "@nestjs/common",
  "@nestjs/core",
  "evlog",
  "react",
  "react-dom",
  "rxjs",
]);

export const evaluateSpecifier = (
  role: BoundaryRole,
  file: string,
  specifier: string,
): ReadonlyArray<BoundaryViolation> => {
  const violations: Array<BoundaryViolation> = [];
  const dependency = packageNameForSpecifier(specifier);
  if (
    role === "core" &&
    (forbiddenCorePackages.has(dependency) || dependency.startsWith("@sentry/"))
  ) {
    violations.push({ rule: "boundary/core-forbidden-framework", file, specifier });
  }
  if (
    role === "domain" &&
    (specifier.startsWith("effect/unstable/observability") ||
      specifier.startsWith("effect/unstable/http") ||
      dependency.startsWith("@opentelemetry/"))
  ) {
    violations.push({ rule: "boundary/domain-forbidden-otlp", file, specifier });
  }
  if (
    role === "domain" &&
    (dependency.startsWith("@sentry/") ||
      dependency.startsWith("@axiomhq/") ||
      dependency === "axiom")
  ) {
    violations.push({ rule: "boundary/domain-forbidden-provider", file, specifier });
  }
  if (
    role === "domain" &&
    (specifier === "effect/Metric" ||
      specifier.startsWith("@equipe-tech/observability/metrics") ||
      dependency === "@opentelemetry/api")
  ) {
    violations.push({ rule: "boundary/domain-forbidden-metric-api", file, specifier });
  }
  return violations;
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
      const imported = new Bun.Transpiler({ loader: "ts" }).scanImports(
        source.replace(/^#!.*\n/, ""),
      );
      for (const importedFile of imported) {
        const specifier = importedFile.path;
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

if (import.meta.main) {
  const violations = await checkPackageBoundaries();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.rule}: ${violation.file} imports ${violation.specifier}`);
    }
    process.exit(1);
  }
  console.log("Package boundaries passed.");
}
