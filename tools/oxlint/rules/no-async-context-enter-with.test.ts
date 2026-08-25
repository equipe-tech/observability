import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noAsyncContextEnterWithRule } from "./no-async-context-enter-with.ts";

test("rejects AsyncLocalStorage.enterWith", () => {
  new RuleTester().run("no-async-context-enter-with", noAsyncContextEnterWithRule, {
    valid: [
      {
        filename: "src/nestjs/RequestScope.ts",
        code: "requestScope.run(store, () => next.handle());",
      },
      {
        filename: "src/nestjs/RequestScope.ts",
        code: "const store = requestScope.getStore();",
      },
    ],
    invalid: [
      {
        filename: "src/nestjs/RequestScope.ts",
        code: "requestScope.enterWith(store);",
        errors: [{ messageId: "enterWith" }],
        output: null,
      },
    ],
  });
});
