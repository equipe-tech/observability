import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const error = { messageId: "chained" };

test("rejects one complete assertion chain and permits const assertions", () => {
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
      {
        filename: "src/telemetry/config.ts",
        code: "const config = ({ mode: 'strict' } as const) as const;",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/unsafe.ts",
        code: "const event = payload as unknown as TelemetryEvent;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/parenthesized.ts",
        code: "const event = (payload as unknown) as TelemetryEvent;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/triple.ts",
        code: "const event = payload as unknown as object as TelemetryEvent;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/angle.ts",
        code: "const event = <TelemetryEvent>(<unknown>payload);",
        errors: [error],
        output: null,
      },
    ],
  });
});
