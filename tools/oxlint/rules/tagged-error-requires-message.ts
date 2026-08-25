import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const isTaggedErrorCallee = (callee: ESTree.Expression): boolean => {
  if (callee.type === "Identifier") {
    return callee.name === "TaggedError";
  }
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "TaggedError"
  );
};

export const taggedErrorRequiresMessageRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a message field on Schema.TaggedError declarations so every failure carries a public, human-readable message.",
    },
    messages: {
      requiresMessage:
        "This tagged error has no `message` field. Every error carries a stable code and a public message so a caller or an operator can act on it without reading the source.",
    },
  },
  create(context) {
    const checkClass = (node: ESTree.Class): void => {
      const superClass = node.superClass;
      if (!superClass || superClass.type !== "CallExpression") {
        return;
      }
      const factory = superClass.callee;
      if (factory.type !== "CallExpression" || !isTaggedErrorCallee(factory.callee)) {
        return;
      }
      const fields = superClass.arguments[1];
      if (fields === undefined || fields.type !== "ObjectExpression") {
        return;
      }
      let hasSpread = false;
      let hasMessage = false;
      for (const property of fields.properties) {
        if (property.type === "SpreadElement") {
          hasSpread = true;
          continue;
        }
        if (property.computed) {
          continue;
        }
        const key = property.key;
        if (
          (key.type === "Identifier" && key.name === "message") ||
          (key.type === "Literal" && key.value === "message")
        ) {
          hasMessage = true;
        }
      }
      if (!hasMessage && !hasSpread) {
        context.report({ node: fields, messageId: "requiresMessage" });
      }
    };
    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
});
