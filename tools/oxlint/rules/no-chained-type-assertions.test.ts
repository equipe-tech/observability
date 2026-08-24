import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

test("rejects chained assertions and keeps single assertions visible", () => {
  new RuleTester().run("no-chained-type-assertions", noChainedTypeAssertionsRule, {
    valid: [
      {
        filename: "src/telemetry/event.ts",
        code: "const event = parseTelemetryEvent(payload);",
      },
      {
        filename: "src/telemetry/level.ts",
        code: 'const level = "info" as LogLevel;',
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/unsafe.ts",
        code: "const event = payload as unknown as TelemetryEvent;",
        errors: [{ messageId: "chained" }],
        output: null,
      },
      {
        filename: "src/telemetry/parenthesized.ts",
        code: "const event = (payload as unknown) as TelemetryEvent;",
        errors: [{ messageId: "chained" }],
        output: null,
      },
    ],
  });
});
