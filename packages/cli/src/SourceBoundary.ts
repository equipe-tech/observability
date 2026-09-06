import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { parse, walk, type Node, type Program } from "yuku-parser";

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

type SourceBinding = { readonly root: boolean; readonly initializer: Node | null };
type SourceScope = {
  readonly parent: SourceScope | undefined;
  readonly bindings: Map<string, SourceBinding>;
  readonly functionScope: boolean;
};

const bindingNames = (node: Node): ReadonlyArray<string> => {
  if (node.type === "Identifier") return [node.name];
  if (node.type === "ObjectPattern")
    return node.properties.flatMap((property) =>
      bindingNames(property.type === "RestElement" ? property.argument : property.value),
    );
  if (node.type === "ArrayPattern")
    return node.elements.flatMap((element) => (element === null ? [] : bindingNames(element)));
  if (node.type === "AssignmentPattern") return bindingNames(node.left);
  if (node.type === "RestElement") return bindingNames(node.argument);
  return [];
};

const importsEffectMetric = (program: Program): boolean => {
  const scopes = new Map<Node, SourceScope>();
  let current: SourceScope = { parent: undefined, bindings: new Map(), functionScope: true };
  const bind = (node: Node, initializer: Node | null, root = false, scope = current): void => {
    for (const name of bindingNames(node)) scope.bindings.set(name, { root, initializer });
  };
  walk(program, {
    enter: (node) => {
      const functionScope =
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression";
      if (
        (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
        node.id !== null
      )
        bind(node.id, null);
      if (
        functionScope ||
        node.type === "BlockStatement" ||
        node.type === "CatchClause" ||
        node.type === "ForStatement" ||
        node.type === "ForOfStatement" ||
        node.type === "ForInStatement"
      )
        current = { parent: current, bindings: new Map(), functionScope };
      scopes.set(node, current);
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        for (const parameter of node.params) bind(parameter, null);
        if (node.type === "FunctionExpression" && node.id !== null) bind(node.id, null);
      }
      if (node.type === "CatchClause" && node.param !== null) bind(node.param, null);
      if (node.type === "ImportDeclaration")
        for (const specifier of node.specifiers)
          bind(
            specifier.local,
            null,
            node.source.value === "effect" && specifier.type === "ImportNamespaceSpecifier",
          );
      if (node.type === "TSImportEqualsDeclaration")
        bind(
          node.id,
          node.moduleReference,
          node.moduleReference.type === "TSExternalModuleReference" &&
            node.moduleReference.expression.value === "effect",
        );
      if (node.type === "VariableDeclaration") {
        let scope = current;
        while (node.kind === "var" && !scope.functionScope && scope.parent !== undefined)
          scope = scope.parent;
        for (const declaration of node.declarations)
          bind(
            declaration.id,
            declaration.id.type === "Identifier" ? declaration.init : null,
            false,
            scope,
          );
      }
    },
    leave: (node) => {
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "BlockStatement" ||
        node.type === "CatchClause" ||
        node.type === "ForStatement" ||
        node.type === "ForOfStatement" ||
        node.type === "ForInStatement"
      )
        current = current.parent ?? current;
    },
  });
  const isRoot = (node: Node | null, visited = new Set<SourceBinding>()): boolean => {
    if (node === null) return false;
    if (
      node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSSatisfiesExpression"
    )
      return isRoot(node.expression, visited);
    if (node.type === "AwaitExpression") return isRoot(node.argument, visited);
    if (node.type === "ImportExpression")
      return node.source.type === "Literal" && node.source.value === "effect";
    if (node.type === "CallExpression")
      return (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments[0]?.type === "Literal" &&
        node.arguments[0].value === "effect"
      );
    if (node.type !== "Identifier") return false;
    let scope = scopes.get(node);
    while (scope !== undefined) {
      const binding = scope.bindings.get(node.name);
      if (binding !== undefined) {
        if (visited.has(binding)) return false;
        visited.add(binding);
        return binding.root || isRoot(binding.initializer, visited);
      }
      scope = scope.parent;
    }
    return false;
  };
  const isMetric = (node: Node): boolean =>
    node.type === "Identifier"
      ? node.name === "Metric"
      : node.type === "Literal" && node.value === "Metric";
  let found = false;
  walk(program, {
    ImportDeclaration: (node) => {
      if (
        node.source.value === "effect" &&
        node.specifiers.some(
          (specifier) => specifier.type === "ImportSpecifier" && isMetric(specifier.imported),
        )
      )
        found = true;
    },
    ExportNamedDeclaration: (node) => {
      if (
        node.source?.value === "effect" &&
        node.specifiers.some((specifier) => isMetric(specifier.local))
      )
        found = true;
    },
    ExportAllDeclaration: (node) => {
      if (node.source.value === "effect") found = true;
    },
    MemberExpression: (node) => {
      if (
        isRoot(node.object) &&
        isMetric(node.property) &&
        (!node.computed || node.property.type === "Literal")
      )
        found = true;
    },
    TSQualifiedName: (node) => {
      if (isRoot(node.left) && isMetric(node.right)) found = true;
    },
    VariableDeclarator: (node) => {
      if (
        node.id.type === "ObjectPattern" &&
        isRoot(node.init) &&
        node.id.properties.some(
          (property) =>
            property.type === "Property" &&
            isMetric(property.key) &&
            (!property.computed || property.key.type === "Literal"),
        )
      )
        found = true;
    },
    TSImportType: (node) => {
      let qualifier: Node | null = node.qualifier;
      while (qualifier?.type === "TSQualifiedName") qualifier = qualifier.left;
      if (node.source.value === "effect" && qualifier !== null && isMetric(qualifier)) found = true;
    },
  });
  return found;
};

export type SourceDependency = {
  readonly specifier: string;
  readonly kind: DependencyKind | undefined;
};

export const scanSourceDependencies = (source: string): ReadonlyArray<SourceDependency> => {
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
    TSImportType: (expression) => {
      specifiers.push(expression.source.value);
    },
  });
  const metric = specifiers.includes("effect") && importsEffectMetric(program);
  return specifiers.map((specifier) => ({
    specifier,
    kind: specifier === "effect" && metric ? "metric-api" : classifyDependency(specifier),
  }));
};

export const scanImportSpecifiers = (source: string): ReadonlyArray<string> =>
  scanSourceDependencies(source).map((dependency) => dependency.specifier);

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
