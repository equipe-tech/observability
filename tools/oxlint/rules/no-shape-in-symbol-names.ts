import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

const reportForbiddenName = (context: Context, node: ESTree.Node, name: string): void => {
  if (name.toLowerCase().includes("shape")) {
    context.report({ node, messageId: "forbiddenTerm", data: { name } });
  }
};

export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in declared symbol names; name the domain concept instead.',
    },
    messages: {
      forbiddenTerm:
        '`{{name}}` names a structure, not a concept. "Shape" hides what the data means; name the domain concept the symbol represents.',
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") {
          reportForbiddenName(context, node.id, node.id.name);
        }
      },
      FunctionDeclaration(node) {
        if (node.id !== null && node.id !== undefined) {
          reportForbiddenName(context, node.id, node.id.name);
        }
      },
      ClassDeclaration(node) {
        if (node.id !== null && node.id !== undefined) {
          reportForbiddenName(context, node.id, node.id.name);
        }
      },
      TSTypeAliasDeclaration(node) {
        reportForbiddenName(context, node.id, node.id.name);
      },
      TSInterfaceDeclaration(node) {
        reportForbiddenName(context, node.id, node.id.name);
      },
      TSEnumDeclaration(node) {
        reportForbiddenName(context, node.id, node.id.name);
      },
      PropertyDefinition(node) {
        if (node.key.type === "Identifier") {
          reportForbiddenName(context, node.key, node.key.name);
        }
      },
      TSPropertySignature(node) {
        if (node.key.type === "Identifier") {
          reportForbiddenName(context, node.key, node.key.name);
        }
      },
      Property(node) {
        if (node.key.type === "Identifier") {
          reportForbiddenName(context, node.key, node.key.name);
        }
      },
    };
  },
});
