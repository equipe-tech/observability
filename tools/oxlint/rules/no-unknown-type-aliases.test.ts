import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const error = { messageId: "unknownAlias" };

test("rejects direct and transitive aliases of unknown", () => {
  new RuleTester().run("no-unknown-type-aliases", noUnknownTypeAliasesRule, {
    valid: [
      {
        filename: "src/telemetry/event.ts",
        code: "type TelemetryEvent = typeof TelemetryEventSchema.Type;",
      },
      {
        filename: "src/telemetry/generic.ts",
        code: "type Container<Value> = Value; type Payload = Container<unknown>;",
      },
      {
        filename: "src/telemetry/cycle.ts",
        code: "type First = Second; type Second = First;",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/payload.ts",
        code: "type RawPayload = unknown;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/transitive.ts",
        code: "type RawPayload = unknown; type Payload = RawPayload;",
        errors: [error, error],
        output: null,
      },
      {
        filename: "src/telemetry/parenthesized.ts",
        code: "type RawPayload = (unknown);",
        errors: [error],
        output: null,
      },
    ],
  });
});
