import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

const reportBroadParameters = (
  context: Context,
  params: ReadonlyArray<ESTree.ParamPattern>,
): void => {
  for (const param of params) {
    if (param.type !== "Identifier") {
      continue;
    }
    const annotation = param.typeAnnotation;
    if (annotation === null || annotation === undefined) {
      continue;
    }
    if (annotation.typeAnnotation.type === "TSObjectKeyword") {
      context.report({
        node: param,
        messageId: "objectParameter",
        data: { parameter: param.name },
      });
    }
  }
};

export const noObjectParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow function parameters typed as the broad `object` type; inputs must use an owner-provided type parsed at their boundary.",
    },
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` accepts the broad `object` type. Use the expected owner type, or decode the external input at its I/O boundary.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        reportBroadParameters(context, node.params);
      },
      FunctionExpression(node) {
        reportBroadParameters(context, node.params);
      },
      ArrowFunctionExpression(node) {
        reportBroadParameters(context, node.params);
      },
    };
  },
});
