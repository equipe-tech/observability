import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const DependencyMap = Schema.Record(Schema.String, Schema.String);
const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
});
const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);

export type BoundaryRole = "core" | "adapter" | "bootstrap" | "domain";
export type BoundaryViolation = {
  readonly rule: string;
  readonly file: string;
  readonly specifier: string;
};

const packageNameForSpecifier = (specifier: string): string => {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.slice(0, 2).join("/");
  }
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

const packageDirectories = async (): Promise<ReadonlyArray<string>> => {
  const directories: Array<string> = [];
  const manifests = new Bun.Glob("packages/*/package.json");
  for await (const manifest of manifests.scan({ cwd: root })) {
    directories.push(dirname(join(root, manifest)));
  }
  return directories.toSorted();
};

const declaredDependencies = (manifest: typeof PackageManifest.Type): Set<string> =>
  new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

const sourceRole = (directory: string): BoundaryRole =>
  basename(directory) === "telemetry" ? "core" : "adapter";

export const checkPackageBoundaries = async (): Promise<ReadonlyArray<BoundaryViolation>> => {
  const violations: Array<BoundaryViolation> = [];
  for (const directory of await packageDirectories()) {
    const manifestValue: unknown = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const manifest = decodePackageManifest(manifestValue);
    const declared = declaredDependencies(manifest);
    const sources = new Bun.Glob("src/**/*.ts");
    for await (const sourcePath of sources.scan({ cwd: directory })) {
      const absolute = join(directory, sourcePath);
      const source = await readFile(absolute, "utf8");
      const imported = new Bun.Transpiler({ loader: "ts" }).scanImports(
        source.replace(/^#!.*\n/, ""),
      );
      for (const importedFile of imported) {
        const specifier = importedFile.path;
        const file = relative(root, absolute).split(sep).join("/");
        violations.push(...evaluateSpecifier(sourceRole(directory), file, specifier));
        if (
          !specifier.startsWith(".") &&
          !specifier.startsWith("node:") &&
          packageNameForSpecifier(specifier) !== manifest.name &&
          !declared.has(packageNameForSpecifier(specifier))
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
