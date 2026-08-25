import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const exemptFilePattern = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/scripts\/)/;

const isProcessEnv = (node: ESTree.Expression): boolean => {
  if (node.type !== "MemberExpression") {
    return false;
  }
  if (node.object.type !== "Identifier" || node.object.name !== "process") {
    return false;
  }
  if (!node.computed) {
    return node.property.type === "Identifier" && node.property.name === "env";
  }
  return node.property.type === "Literal" && node.property.value === "env";
};

export const noAmbientEnvReadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading individual process.env variables; the whole environment is decoded once with a Schema at the process boundary.",
    },
    messages: {
      ambientEnvRead:
        "Do not read individual `process.env` variables. Decode `process.env` once with a Schema at the process boundary and read the decoded configuration, so validation and defaults live in one place.",
    },
  },
  create(context) {
    if (exemptFilePattern.test(context.filename)) {
      return {};
    }
    return {
      MemberExpression(node) {
        if (isProcessEnv(node.object)) {
          context.report({ node, messageId: "ambientEnvRead" });
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "ObjectPattern" && node.init !== null && isProcessEnv(node.init)) {
          context.report({ node, messageId: "ambientEnvRead" });
        }
      },
    };
  },
});
