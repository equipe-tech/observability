import { defineRule } from "@oxlint/plugins";

export const noVoidOperatorRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the value-level void operator; it detaches promises and hides their rejections.",
    },
    messages: {
      voidOperator:
        "The `void` operator detaches the expression, so a rejection becomes an unhandled event instead of a tracked failure. Integrate external async work with the Effect constructors, or restructure the synchronous expression so `void` is not needed.",
    },
  },
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "void") {
          context.report({ node, messageId: "voidOperator" });
        }
      },
    };
  },
});
