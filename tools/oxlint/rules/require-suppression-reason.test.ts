import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { requireSuppressionReasonRule } from "./require-suppression-reason.ts";

test("requires suppression directives to carry a reason", () => {
  new RuleTester().run("require-suppression-reason", requireSuppressionReasonRule, {
    valid: [
      {
        filename: "src/telemetry/ingest.ts",
        code: "// oxlint-disable-next-line typescript/no-explicit-any -- third-party callback contract\nregister(handler);",
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "// The upstream type is wrong until SDK 3.2 ships.\n// oxlint-disable-next-line typescript/no-explicit-any\nregister(handler);",
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "// A plain comment without directives.\nregister(handler);",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/ingest.ts",
        code: "// oxlint-disable-next-line typescript/no-explicit-any\nregister(handler);",
        errors: [{ messageId: "missingReason" }],
        output: null,
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "/* eslint-disable no-console */\nconsole.log(value);",
        errors: [{ messageId: "missingReason" }],
        output: null,
      },
      {
        filename: "src/telemetry/ingest.ts",
        code: "register(handler); // oxlint-disable-line typescript/no-explicit-any\n",
        errors: [{ messageId: "missingReason" }],
        output: null,
      },
    ],
  });
});
