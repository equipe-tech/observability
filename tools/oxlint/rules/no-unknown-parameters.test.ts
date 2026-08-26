import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const error = { messageId: "unknownParameter" };

test("rejects unknown parameters across function contracts except cause", () => {
  new RuleTester().run("no-unknown-parameters", noUnknownParametersRule, {
    valid: [
      {
        filename: "src/telemetry/error.ts",
        code: "const wrap = (cause: unknown): TelemetryError => TelemetryError.fromCause(cause);",
      },
      {
        filename: "src/telemetry/error-contract.ts",
        code: "interface ErrorFactory { wrap(cause: unknown): TelemetryError }",
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
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/signature.ts",
        code: "interface Emitter { emit(event: unknown): void }",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/function-type.ts",
        code: "type Emitter = (event: unknown) => void;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/destructured.ts",
        code: "const emit = ({ event }: unknown): void => {};",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/rest.ts",
        code: "function emit(...events: unknown): void {}",
        errors: [error],
        output: null,
      },
    ],
  });
});
