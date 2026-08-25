import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noVoidOperatorRule } from "./no-void-operator.ts";

test("rejects the value-level void operator", () => {
  new RuleTester().run("no-void-operator", noVoidOperatorRule, {
    valid: [
      {
        filename: "src/telemetry/flush.ts",
        code: "const flush = (): void => runtime.runSync(flushSpans);",
      },
      {
        filename: "src/telemetry/flush.ts",
        code: "type Deliver = () => Promise<void>;",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/flush.ts",
        code: "void deliver();",
        errors: [{ messageId: "voidOperator" }],
        output: null,
      },
      {
        filename: "src/telemetry/flush.ts",
        code: "const noop = void 0;",
        errors: [{ messageId: "voidOperator" }],
        output: null,
      },
    ],
  });
});
