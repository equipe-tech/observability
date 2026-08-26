import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noReflectApplyRule } from "./no-reflect-apply.ts";

const error = { messageId: "reflectApply" };

test("rejects calls to global Reflect.apply", () => {
  new RuleTester().run("no-reflect-apply", noReflectApplyRule, {
    valid: [
      "operation(...args);",
      "const Reflect = adapter; Reflect.apply(operation, owner, args);",
      "adapter.Reflect.apply(operation, owner, args);",
    ],
    invalid: [
      {
        code: "Reflect.apply(operation, owner, args);",
        errors: [error],
        output: null,
      },
      {
        code: "Reflect['apply'](operation, owner, args);",
        errors: [error],
        output: null,
      },
    ],
  });
});
