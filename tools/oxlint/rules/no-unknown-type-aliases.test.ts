import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

test("rejects type aliases that only rename unknown", () => {
  new RuleTester().run("no-unknown-type-aliases", noUnknownTypeAliasesRule, {
    valid: [
      {
        filename: "src/telemetry/event.ts",
        code: "type TelemetryEvent = typeof TelemetryEventSchema.Type;",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/payload.ts",
        code: "type RawPayload = unknown;",
        errors: [{ messageId: "unknownAlias" }],
        output: null,
      },
    ],
  });
});
