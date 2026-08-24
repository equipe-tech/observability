import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

const reportUnknownParameters = (
  context: Context,
  params: ReadonlyArray<ESTree.ParamPattern>,
): void => {
  for (const param of params) {
    if (param.type !== "Identifier") {
      continue;
    }
    if (param.name === "cause") {
      continue;
    }
    const annotation = param.typeAnnotation;
    if (annotation === null || annotation === undefined) {
      continue;
    }
    if (annotation.typeAnnotation.type === "TSUnknownKeyword") {
      context.report({
        node: param,
        messageId: "unknownParameter",
        data: { parameter: param.name },
      });
    }
  }
};

export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input with a schema at the I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` accepts `unknown` without establishing its contract. Define the expected schema and decode the value at the boundary so it becomes a strongly typed domain value.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        reportUnknownParameters(context, node.params);
      },
      FunctionExpression(node) {
        reportUnknownParameters(context, node.params);
      },
      ArrowFunctionExpression(node) {
        reportUnknownParameters(context, node.params);
      },
    };
  },
});
