import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const throwMatchers = new Set(["toThrow", "toThrowError"]);

const describeChain = (start: ESTree.Expression): { negated: boolean; rootedAtExpect: boolean } => {
  let current = start;
  let negated = false;
  while (current.type === "MemberExpression") {
    if (
      !current.computed &&
      current.property.type === "Identifier" &&
      current.property.name === "not"
    ) {
      negated = true;
    }
    current = current.object;
  }
  return {
    negated,
    rootedAtExpect:
      current.type === "CallExpression" &&
      current.callee.type === "Identifier" &&
      current.callee.name === "expect",
  };
};

export const noVacuousThrowAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require throw assertions to name the expected error; an unargumented toThrow passes for any thrown value.",
    },
    messages: {
      vacuousThrow:
        "`{{matcher}}()` with no argument passes for any thrown value, so the test stops guarding the failure it was written for. Name the expected error: a message substring, a regex, an error class, or an object with `message`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.arguments.length > 0) {
          return;
        }
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !throwMatchers.has(callee.property.name)
        ) {
          return;
        }
        const { negated, rootedAtExpect } = describeChain(callee.object);
        if (negated || !rootedAtExpect) {
          return;
        }
        context.report({
          node,
          messageId: "vacuousThrow",
          data: { matcher: callee.property.name },
        });
      },
    };
  },
});
