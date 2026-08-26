import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const serviceConstructorName = /^make[A-Z]/u;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function isProjectLocalImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function getImportedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

export const noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow project-local make<CapabilityName> imports outside test and spec files.",
    },
    messages: {
      serviceConstructorImport:
        "Do not import Effect service constructor `{{name}}` into runtime code. Import the owning Layer, yield the contextual service, and propagate its requirements to the composition root.",
    },
  },
  create(context) {
    const isTestFile = testFile.test(context.filename.replaceAll("\\", "/"));
    return {
      ImportDeclaration(node) {
        if (isTestFile || !isProjectLocalImport(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            continue;
          }
          const importedName = getImportedName(specifier);
          if (!serviceConstructorName.test(importedName)) {
            continue;
          }
          context.report({
            node: specifier,
            messageId: "serviceConstructorImport",
            data: { name: importedName },
          });
        }
      },
    };
  },
});
