import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noVacuousThrowAssertionRule } from "./no-vacuous-throw-assertion.ts";

test("requires throw assertions to name the expected error", () => {
  new RuleTester().run("no-vacuous-throw-assertion", noVacuousThrowAssertionRule, {
    valid: [
      {
        filename: "test/errors.test.ts",
        code: 'expect(() => parse(bad)).toThrow("invalid dataset name");',
      },
      {
        filename: "test/errors.test.ts",
        code: "expect(() => parse(bad)).toThrowError(InvalidBatch);",
      },
      {
        filename: "test/errors.test.ts",
        code: "expect(() => parse(good)).not.toThrow();",
      },
      {
        filename: "test/errors.test.ts",
        code: "await expect(promise).rejects.toThrow(/rejected/);",
      },
      {
        filename: "test/errors.test.ts",
        code: "helper.toThrow();",
      },
    ],
    invalid: [
      {
        filename: "test/errors.test.ts",
        code: "expect(() => parse(bad)).toThrow();",
        errors: [{ messageId: "vacuousThrow" }],
        output: null,
      },
      {
        filename: "test/errors.test.ts",
        code: "await expect(promise).rejects.toThrowError();",
        errors: [{ messageId: "vacuousThrow" }],
        output: null,
      },
    ],
  });
});
