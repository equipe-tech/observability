import { defineRule } from "@oxlint/plugins";

export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
    },
    messages: {
      runtimeTypeof:
        "A runtime `typeof` check narrows an unparsed representation without establishing its contract. Parse the value into a strongly typed domain type at the I/O boundary where it originates.",
    },
  },
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "typeof") {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
