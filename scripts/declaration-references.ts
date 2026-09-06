import { isAbsolute, win32 } from "node:path";

type DeclarationReference =
  | { readonly kind: "module"; readonly specifier: string }
  | { readonly kind: "types"; readonly specifier: string }
  | { readonly kind: "path"; readonly specifier: string };

export type DeclarationReferenceViolation =
  | { readonly kind: "source-path"; readonly specifier: string }
  | { readonly kind: "undeclared"; readonly specifier: string };

const dependencyName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

export const declarationReferences = (source: string): ReadonlyArray<DeclarationReference> => {
  const references: Array<DeclarationReference> = [];
  for (const match of source.matchAll(/(?:from\s+|import\(\s*|require\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) references.push({ kind: "module", specifier });
  }
  for (const match of source.matchAll(
    /^\s*\/\/\/\s*<reference\s+(types|path)=["']([^"']+)["']\s*\/?>/gm,
  )) {
    const kind = match[1];
    const specifier = match[2];
    if ((kind === "types" || kind === "path") && specifier !== undefined) {
      references.push({ kind, specifier });
    }
  }
  return references;
};

export const isSourcePathReference = (specifier: string): boolean =>
  isAbsolute(specifier) ||
  win32.isAbsolute(specifier) ||
  specifier.includes("packages/") ||
  specifier.includes("/src/") ||
  /(?:^|\/)src\//.test(specifier) ||
  /\.(?:d\.)?[cm]?tsx?$/.test(specifier);

export const declarationReferenceViolations = (
  source: string,
  declaredDependencies: ReadonlySet<string>,
): ReadonlyArray<DeclarationReferenceViolation> => {
  const violations: Array<DeclarationReferenceViolation> = [];
  for (const reference of declarationReferences(source)) {
    if (reference.kind === "path") {
      if (isSourcePathReference(reference.specifier)) {
        violations.push({ kind: "source-path", specifier: reference.specifier });
      }
      continue;
    }
    if (
      !reference.specifier.startsWith(".") &&
      !reference.specifier.startsWith("node:") &&
      !declaredDependencies.has(dependencyName(reference.specifier))
    ) {
      violations.push({ kind: "undeclared", specifier: reference.specifier });
    }
  }
  return violations;
};
