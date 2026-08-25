import { defineRule } from "@oxlint/plugins";

const disablePattern = /\b(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/u;
const directivePattern = /\b(?:eslint|oxlint)-(?:disable(?:-next-line|-line)?|enable)\b/u;
const reasonPattern = /--\s*\S/u;

export const requireSuppressionReasonRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every lint suppression directive to carry a reason, inline or in a comment on the line above.",
    },
    messages: {
      missingReason:
        "This suppression has no reason. Add a `-- <why>` trailer to the directive, or a comment on the line directly above that explains why the rule does not apply here.",
    },
  },
  create(context) {
    return {
      Program(node) {
        for (const comment of node.comments) {
          if (!disablePattern.test(comment.value)) {
            continue;
          }
          if (reasonPattern.test(comment.value)) {
            continue;
          }
          const lineAbove = comment.loc.start.line - 1;
          const documentedAbove = node.comments.some(
            (other) =>
              other !== comment &&
              !directivePattern.test(other.value) &&
              other.loc.end.line === lineAbove,
          );
          if (!documentedAbove) {
            context.report({ node: comment, messageId: "missingReason" });
          }
        }
      },
    };
  },
});
