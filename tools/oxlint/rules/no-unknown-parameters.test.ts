import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

test("rejects unknown parameters except cause", () => {
  new RuleTester().run("no-unknown-parameters", noUnknownParametersRule, {
    valid: [
      {
        filename: "src/telemetry/error.ts",
        code: "const wrap = (cause: unknown): TelemetryError => TelemetryError.fromCause(cause);",
      },
      {
        filename: "src/telemetry/emit.ts",
        code: "const emit = (event: TelemetryEvent): void => { transport.send(event); };",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/broad.ts",
        code: "const emit = (event: unknown): void => { transport.send(event); };",
        errors: [{ messageId: "unknownParameter" }],
        output: null,
      },
    ],
  });
});
