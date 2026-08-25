import { defineRule } from "@oxlint/plugins";

const testFilePattern = /(\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const requireFetchAbortSignalRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every fetch call to pass an explicit AbortSignal so interruption and timeouts cancel the request.",
    },
    messages: {
      missingSignal:
        "This fetch call has no `signal`, so interruption and timeouts cannot cancel the request. Inside `Effect.tryPromise`, forward the callback signal: `try: (signal) => fetch(url, { ...init, signal })`.",
    },
  },
  create(context) {
    if (testFilePattern.test(context.filename)) {
      return {};
    }
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "fetch") {
          return;
        }
        const options = node.arguments[1];
        if (options !== undefined && options.type === "ObjectExpression") {
          const hasSignal = options.properties.some(
            (property) =>
              property.type === "Property" &&
              !property.computed &&
              ((property.key.type === "Identifier" && property.key.name === "signal") ||
                (property.key.type === "Literal" && property.key.value === "signal")),
          );
          if (hasSignal) {
            return;
          }
        }
        context.report({ node, messageId: "missingSignal" });
      },
    };
  },
});
