import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const error = { messageId: "forbiddenTerm" };

test("rejects shape in declarations without reporting symbol references", () => {
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
        code: "const eventShape = buildTelemetryEvent(context); consume(eventShape);",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/parameter.ts",
        code: "function emit(eventShape: TelemetryEvent): void {}",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/destructured.ts",
        code: "const { eventShape } = telemetry; consume(eventShape);",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/property.ts",
        code: "const payload = { eventShape };",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/method.ts",
        code: "class Telemetry { eventShape(): void {} }",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/signature.ts",
        code: "type Emitter = (eventShape: TelemetryEvent) => void;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/import.ts",
        code: 'import { event as eventShape } from "./event.ts";',
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/named-type.ts",
        code: "type EventShape = { readonly name: string };",
        errors: [error],
        output: null,
      },
    ],
  });
});
