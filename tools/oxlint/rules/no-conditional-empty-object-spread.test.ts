import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";

test("rejects conditional empty-object spreads used to omit fields", () => {
  new RuleTester().run("no-conditional-empty-object-spread", noConditionalEmptyObjectSpreadRule, {
    valid: [
      {
        filename: "src/telemetry/attributes.ts",
        code: "const attributes = { ...baseAttributes, ...requestAttributes };",
      },
      {
        filename: "src/telemetry/resource.ts",
        code: "const resource = { service: serviceName, version: serviceVersion };",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/conditional.ts",
        code: "const attributes = { ...(hasTrace ? { traceId } : {}) };",
        errors: [{ messageId: "avoid" }],
        output: null,
      },
      {
        filename: "src/telemetry/logical.ts",
        code: "const attributes = { ...(hasTrace && { traceId }) };",
        errors: [{ messageId: "avoid" }],
        output: null,
      },
    ],
  });
});
