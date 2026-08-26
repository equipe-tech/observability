import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noReflectGetRule } from "./no-reflect-get.ts";

const error = { messageId: "reflectGet" };

test("rejects calls to global Reflect.get", () => {
  new RuleTester().run("no-reflect-get", noReflectGetRule, {
    valid: [
      "owner[key];",
      "const Reflect = adapter; Reflect.get(owner, key);",
      "adapter.Reflect.get(owner, key);",
    ],
    invalid: [
      { code: "Reflect.get(owner, key);", errors: [error], output: null },
      { code: "Reflect['get'](owner, key);", errors: [error], output: null },
    ],
  });
});
