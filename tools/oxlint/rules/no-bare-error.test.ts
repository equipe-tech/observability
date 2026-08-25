import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noBareErrorRule } from "./no-bare-error.ts";

test("requires tagged errors instead of bare Error throws", () => {
  new RuleTester().run("no-bare-error", noBareErrorRule, {
    valid: [
      {
        filename: "src/telemetry/ingest.ts",
        code: 'throw new InvalidBatch({ code: "OBS_INVALID_BATCH", message: "Batch rejected." });',
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "throw cause;",
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "throw new HttpException(rejection, 400);",
      },
      {
        filename: "packages/cli/test/Cli.bun.test.ts",
        code: 'throw new Error("test fixture failure");',
      },
      {
        filename: "scripts/release.ts",
        code: 'throw new Error("The tag already exists.");',
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/ingest.ts",
        code: 'throw new Error("Something went wrong.");',
        errors: [{ messageId: "bareError" }],
        output: null,
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: 'throw Error("no new keyword");',
        errors: [{ messageId: "bareError" }],
        output: null,
      },
    ],
  });
});
