import { defineRule } from "@oxlint/plugins";

const constructorNamePattern = /^make[A-Z]/;
const testFilePattern = /(\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow project-local make<CapabilityName> imports outside test and spec files; resolve capabilities through the service layer instead.",
    },
    messages: {
      serviceConstructorImport:
        "`{{name}}` is a service constructor. Production code must resolve the capability through its service layer; direct construction is reserved for tests.",
    },
  },
  create(context) {
    if (testFilePattern.test(context.filename)) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        if (!node.source.value.startsWith(".")) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            continue;
          }
          if (specifier.imported.type !== "Identifier") {
            continue;
          }
          if (constructorNamePattern.test(specifier.imported.name)) {
            context.report({
              node: specifier,
              messageId: "serviceConstructorImport",
              data: { name: specifier.imported.name },
            });
          }
        }
      },
    };
  },
});
