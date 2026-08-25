import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noForeignDirectiveRule } from "./no-foreign-directive.ts";

test("rejects directives for tools this toolchain does not run", () => {
  new RuleTester().run("no-foreign-directive", noForeignDirectiveRule, {
    valid: [
      {
        filename: "src/telemetry/ingest.ts",
        code: "// oxlint-disable-next-line typescript/no-explicit-any -- third-party contract\nregister(handler);",
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "// A comment that mentions formatting in prose.\nregister(handler);",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/ingest.ts",
        code: "// biome-ignore lint/suspicious/noExplicitAny: legacy\nregister(handler);",
        errors: [{ messageId: "foreignDirective" }],
        output: null,
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "// prettier-ignore\nconst matrix = [1, 0, 0, 1];",
        errors: [{ messageId: "foreignDirective" }],
        output: null,
      },
    ],
  });
});
