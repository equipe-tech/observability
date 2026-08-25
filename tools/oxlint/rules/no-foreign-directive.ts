import { defineRule } from "@oxlint/plugins";

const foreignPattern = /\b(biome-ignore|prettier-ignore)\b/u;

export const noForeignDirectiveRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow suppression directives for lint or format tools this toolchain does not run.",
    },
    messages: {
      foreignDirective:
        "`{{kind}}` is not honored by this toolchain (oxlint + oxfmt), so the directive is dead. Remove it; use an oxlint disable directive with a reason when a suppression is required.",
    },
  },
  create(context) {
    return {
      Program(node) {
        for (const comment of node.comments) {
          const match = foreignPattern.exec(comment.value);
          if (match !== null) {
            context.report({
              node: comment,
              messageId: "foreignDirective",
              data: { kind: match[1] },
            });
          }
        }
      },
    };
  },
});
