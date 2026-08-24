import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noObjectParametersRule } from "./no-object-parameters.ts";

test("rejects parameters typed as the broad object type", () => {
  new RuleTester().run("no-object-parameters", noObjectParametersRule, {
    valid: [
      {
        filename: "src/telemetry/emit.ts",
        code: "const emit = (event: TelemetryEvent): void => { transport.send(event); };",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/broad.ts",
        code: "const emit = (event: object): void => { transport.send(event); };",
        errors: [{ messageId: "objectParameter" }],
        output: null,
      },
      {
        filename: "src/telemetry/broad-function.ts",
        code: "function emit(event: object): void { transport.send(event); }",
        errors: [{ messageId: "objectParameter" }],
        output: null,
      },
    ],
  });
});
