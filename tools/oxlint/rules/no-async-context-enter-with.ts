import { defineRule } from "@oxlint/plugins";

export const noAsyncContextEnterWithRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow AsyncLocalStorage.enterWith; it mutates the ambient async context frame with no restore point.",
    },
    messages: {
      enterWith:
        "`enterWith()` binds a store to the ambient async context frame and nothing restores it, so unrelated background work that resumes there adopts the store. Scope the store with `run(store, fn)` at the boundary instead.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "enterWith"
        ) {
          context.report({ node, messageId: "enterWith" });
        }
      },
    };
  },
});
