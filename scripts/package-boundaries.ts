import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, walk } from "yuku-parser";

const root = fileURLToPath(new URL("..", import.meta.url));
const isString = Schema.is(Schema.String);

const DependencyMap = Schema.Record(Schema.String, Schema.String);
const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
});
export const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);

type BoundaryRole = "core" | "adapter" | "bootstrap" | "domain" | "react";
type BoundaryViolation = {
  readonly rule: string;
  readonly file: string;
  readonly specifier: string;
};

type PathOwnership = {
  readonly kind: "exact" | "prefix";
  readonly path: string;
  readonly role: BoundaryRole;
};

type DependencyKind = "framework" | "metric-api" | "otlp" | "provider" | "runtime-platform";

export const defineOwnership = (
  entries: ReadonlyArray<PathOwnership>,
): ReadonlyArray<PathOwnership> => {
  const selectors = new Set<string>();
  for (const entry of entries) {
    const selector = `${entry.kind}:${entry.path}`;
    if (selectors.has(selector)) {
      throw new Error(`Duplicate package ownership selector "${selector}"`);
    }
    selectors.add(selector);
  }
  return entries;
};

const ownership = defineOwnership([
  { kind: "exact", path: "packages/cli/src/main.ts", role: "bootstrap" },
  { kind: "prefix", path: "packages/sentry/src/policy/", role: "domain" },
  { kind: "prefix", path: "packages/sentry/src/", role: "adapter" },
  { kind: "prefix", path: "packages/react/src/", role: "react" },
  { kind: "prefix", path: "packages/nestjs/src/", role: "adapter" },
  { kind: "prefix", path: "packages/evlog/src/", role: "adapter" },
  { kind: "exact", path: "packages/telemetry/src/MetricsRuntime.ts", role: "adapter" },
  { kind: "exact", path: "packages/telemetry/src/PolicyOtlpLogger.ts", role: "adapter" },
  { kind: "exact", path: "packages/telemetry/src/Telemetry.ts", role: "adapter" },
  { kind: "exact", path: "packages/telemetry/src/node/Observability.ts", role: "adapter" },
  {
    kind: "exact",
    path: "packages/telemetry/src/profile/LifecycleRegistry.ts",
    role: "adapter",
  },
  {
    kind: "exact",
    path: "packages/telemetry/src/profile/ObservabilityAdapter.ts",
    role: "adapter",
  },
  { kind: "exact", path: "packages/telemetry/src/testing/index.ts", role: "adapter" },
  {
    kind: "exact",
    path: "packages/telemetry/src/trace/HttpServerOtlpTracer.ts",
    role: "adapter",
  },
  { kind: "prefix", path: "packages/cli/src/", role: "domain" },
  { kind: "prefix", path: "packages/telemetry/src/contract/", role: "domain" },
  { kind: "prefix", path: "packages/telemetry/src/policy/", role: "domain" },
  { kind: "prefix", path: "packages/telemetry/src/profile/", role: "domain" },
]);

export const sourceRole = (file: string): BoundaryRole => {
  for (const owner of ownership) {
    const matches = owner.kind === "exact" ? file === owner.path : file.startsWith(owner.path);
    if (matches) return owner.role;
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
  ["react", new Set(["framework", "otlp", "provider"])],
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

const importSpecifiers = (source: string): ReadonlyArray<string> => {
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
  walk(program, {
    ImportExpression: (expression) => {
      if (expression.source.type === "Literal" && isString(expression.source.value)) {
        specifiers.push(expression.source.value);
      }
    },
  });
  return specifiers;
};

const sourcePathViolation = (
  projectRoot: string,
  packageDirectory: string,
  file: string,
  specifier: string,
): BoundaryViolation | undefined => {
  if (isAbsolute(specifier) || win32.isAbsolute(specifier)) {
    return { rule: "boundary/absolute-file-import", file, specifier };
  }
  if (!specifier.startsWith(".")) return undefined;
  const target = relative(projectRoot, resolve(dirname(join(projectRoot, file)), specifier))
    .split(sep)
    .join("/");
  const packageSource = relative(projectRoot, packageDirectory).split(sep).join("/");
  if (target.startsWith("packages/") && !target.startsWith(`${packageSource}/`)) {
    return { rule: "boundary/cross-package-source-import", file, specifier };
  }
  return undefined;
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
      for (const specifier of importSpecifiers(source)) {
        violations.push(...evaluateSpecifier(sourceRole(file), file, specifier));
        const pathViolation = sourcePathViolation(projectRoot, directory, file, specifier);
        if (pathViolation !== undefined) {
          violations.push(pathViolation);
          continue;
        }
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
