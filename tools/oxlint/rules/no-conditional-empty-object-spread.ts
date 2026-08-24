import { defineRule } from "@oxlint/plugins";

export const noConditionalEmptyObjectSpreadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object spreads that conditionally spread an empty object to omit fields.",
    },
    messages: {
      avoid:
        "Do not spread a conditional whose branch is an empty object. Assign the property directly, or build the object in separate statements so each field has one clear origin.",
    },
  },
  create(context) {
    return {
      SpreadElement(node) {
        const argument = node.argument;
        if (argument.type === "ConditionalExpression") {
          const consequentEmpty =
            argument.consequent.type === "ObjectExpression" &&
            argument.consequent.properties.length === 0;
          const alternateEmpty =
            argument.alternate.type === "ObjectExpression" &&
            argument.alternate.properties.length === 0;
          if (consequentEmpty || alternateEmpty) {
            context.report({ node, messageId: "avoid" });
          }
        }
        if (argument.type === "LogicalExpression" && argument.operator === "&&") {
          context.report({ node, messageId: "avoid" });
        }
      },
    };
  },
});
