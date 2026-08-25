import { defineRule } from "@oxlint/plugins";

const exemptFilePattern = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/scripts\/)/;

export const noBareErrorRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow throwing bare Error values in production code; failures must be tagged errors so telemetry stays structured.",
    },
    messages: {
      bareError:
        "A bare `Error` is an unclassified failure with string-only telemetry. Model expected failures as `Schema.TaggedError` values in the Effect error channel. For an invariant defect, throw a tagged error with a stable code.",
    },
  },
  create(context) {
    if (exemptFilePattern.test(context.filename)) {
      return {};
    }
    return {
      ThrowStatement(node) {
        const argument = node.argument;
        if (argument.type !== "NewExpression" && argument.type !== "CallExpression") {
          return;
        }
        if (argument.callee.type === "Identifier" && argument.callee.name === "Error") {
          context.report({ node: argument, messageId: "bareError" });
        }
      },
    };
  },
});
