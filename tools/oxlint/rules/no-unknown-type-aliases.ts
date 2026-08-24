import { defineRule } from "@oxlint/plugins";

export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must stay visible at the boundary that owns it.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` only renames `unknown`. Keep `unknown` explicit at its boundary, or replace the alias with the parsed owner type.",
    },
  },
  create(context) {
    return {
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation.type === "TSUnknownKeyword") {
          context.report({
            node,
            messageId: "unknownAlias",
            data: { alias: node.id.name },
          });
        }
      },
    };
  },
});
