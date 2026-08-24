import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

test("rejects shape in declared symbol names", () => {
  new RuleTester().run("no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
    valid: [
      {
        filename: "src/telemetry/event.ts",
        code: "const telemetryEvent = buildTelemetryEvent(context);",
      },
      {
        filename: "src/telemetry/contract.ts",
        code: "interface TelemetryEventContract { readonly name: EventName }",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/named-const.ts",
        code: "const eventShape = buildTelemetryEvent(context);",
        errors: [{ messageId: "forbiddenTerm" }],
        output: null,
      },
      {
        filename: "src/telemetry/named-type.ts",
        code: "type EventShape = { readonly name: string };",
        errors: [{ messageId: "forbiddenTerm" }],
        output: null,
      },
      {
        filename: "src/telemetry/named-interface.ts",
        code: "interface PayloadShape { readonly size: number }",
        errors: [{ messageId: "forbiddenTerm" }],
        output: null,
      },
    ],
  });
});
