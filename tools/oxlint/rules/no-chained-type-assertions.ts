import { defineRule } from "@oxlint/plugins";

export const noChainedTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow chained type assertions such as `value as unknown as Target`, including parenthesized chains.",
    },
    messages: {
      chained:
        "A chained type assertion discards the type evidence the value already carries and fabricates the target type without a parse. Keep the precise original type, or parse the value at its I/O boundary before it flows inward.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        let inner = node.expression;
        while (inner.type === "ParenthesizedExpression") {
          inner = inner.expression;
        }
        if (inner.type === "TSAsExpression" || inner.type === "TSTypeAssertion") {
          context.report({ node, messageId: "chained" });
        }
      },
      TSTypeAssertion(node) {
        let inner = node.expression;
        while (inner.type === "ParenthesizedExpression") {
          inner = inner.expression;
        }
        if (inner.type === "TSAsExpression" || inner.type === "TSTypeAssertion") {
          context.report({ node, messageId: "chained" });
        }
      },
    };
  },
});
