import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { parse, walk } from "yuku-parser";

const isString = Schema.is(Schema.String);

export type DependencyKind =
  | "database"
  | "framework"
  | "metric-api"
  | "otlp"
  | "provider"
  | "runtime-platform";

export const packageNameForSpecifier = (specifier: string): string => {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
};

export const classifyDependency = (specifier: string): DependencyKind | undefined => {
  const dependency = packageNameForSpecifier(specifier);
  if (
    specifier === "bun:sqlite" ||
    specifier === "node:sqlite" ||
    dependency === "pg" ||
    dependency === "postgres" ||
    dependency === "drizzle-orm" ||
    dependency === "@prisma/client" ||
    dependency === "typeorm" ||
    dependency === "sequelize"
  ) {
    return "database";
  }
  if (specifier.startsWith("node:")) return "runtime-platform";
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
  return undefined;
};

export const scanImportSpecifiers = (source: string): ReadonlyArray<string> => {
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
    CallExpression: (expression) => {
      const argument = expression.arguments[0];
      if (
        expression.callee.type === "Identifier" &&
        expression.callee.name === "require" &&
        argument?.type === "Literal" &&
        isString(argument.value)
      ) {
        specifiers.push(argument.value);
      }
    },
    ImportExpression: (expression) => {
      if (expression.source.type === "Literal" && isString(expression.source.value)) {
        specifiers.push(expression.source.value);
      }
    },
  });
  return specifiers;
};

export type ApplicationBoundaryViolation = {
  readonly rule: "boundary/application-otlp" | "boundary/absolute-file-import";
  readonly file: string;
  readonly specifier: string;
};

const DependencyMap = Schema.Record(Schema.String, Schema.String);
const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
});
export const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const scanSourceFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const files: Array<string> = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...(await scanSourceFiles(path)));
    } else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(path);
    }
  }
  return files.sort();
};

export const findApplicationOtlpImports = async (
  projectRoot: string,
  sourceRoots: ReadonlyArray<string>,
): Promise<ReadonlyArray<ApplicationBoundaryViolation>> => {
  const violations: Array<ApplicationBoundaryViolation> = [];
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = join(projectRoot, sourceRoot);
    for (const absolute of await scanSourceFiles(absoluteRoot)) {
      const file = `${sourceRoot}/${relative(absoluteRoot, absolute).split("\\").join("/")}`;
      const source = await readFile(absolute, "utf8");
      for (const specifier of scanImportSpecifiers(source)) {
        if (
          classifyDependency(specifier) === "otlp" &&
          specifier !== "effect/unstable/http" &&
          !specifier.startsWith("effect/unstable/http/")
        ) {
          violations.push({ rule: "boundary/application-otlp", file, specifier });
          continue;
        }
        if (specifier.startsWith(".") === false) continue;
        if (isAbsoluteSpecifier(specifier)) {
          violations.push({ rule: "boundary/absolute-file-import", file, specifier });
        }
      }
    }
  }
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier),
  );
};

const isAbsoluteSpecifier = (specifier: string): boolean =>
  specifier.startsWith("/") || specifier.match(/^[A-Za-z]:[\\/]/) !== null;
