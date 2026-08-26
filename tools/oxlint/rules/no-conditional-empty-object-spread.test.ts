import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";

const error = { messageId: "avoid" };

test("rejects conditional empty-object spreads without banning logical spreads", () => {
  new RuleTester().run("no-conditional-empty-object-spread", noConditionalEmptyObjectSpreadRule, {
    valid: [
      {
        filename: "src/telemetry/attributes.ts",
        code: "const attributes = { ...baseAttributes, ...requestAttributes };",
      },
      {
        filename: "src/telemetry/logical.ts",
        code: "const attributes = { ...(hasTrace && { traceId }) };",
      },
      {
        filename: "src/telemetry/branch.ts",
        code: "const attributes = hasTrace ? { traceId } : {};",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/conditional.ts",
        code: "const attributes = { ...(hasTrace ? { traceId } : {}) };",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/reversed.ts",
        code: "const attributes = { ...(hasTrace ? {} : { traceId }) };",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/parenthesized.ts",
        code: "const attributes = { ...((hasTrace ? { traceId } : {})) };",
        errors: [error],
        output: null,
      },
    ],
  });
});
