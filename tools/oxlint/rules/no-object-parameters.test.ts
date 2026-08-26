import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noObjectParametersRule } from "./no-object-parameters.ts";

const error = { messageId: "objectParameter" };

test("rejects broad object parameters across function contracts and aliases", () => {
  new RuleTester().run("no-object-parameters", noObjectParametersRule, {
    valid: [
      {
        filename: "src/telemetry/emit.ts",
        code: "const emit = (event: TelemetryEvent): void => { transport.send(event); };",
      },
      {
        filename: "src/telemetry/generic.ts",
        code: "type Input = object; function emit<Input>(event: Input): void {}",
      },
      {
        filename: "src/telemetry/infer.ts",
        code: "type Item = object; type Fallback<Input> = Input extends infer Item ? (value: Item) => void : never;",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/broad.ts",
        code: "const emit = (event: object): void => { transport.send(event); };",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/alias.ts",
        code: "type Input = object; function emit(event: Input): void {}",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/union.ts",
        code: "function emit(event: string | object): void {}",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/signature.ts",
        code: "interface Emitter { emit(event: object): void }",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/function-type.ts",
        code: "type Emitter = (event: object) => void;",
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/destructured.ts",
        code: "const emit = ({ event }: object): void => {};",
        errors: [error],
        output: null,
      },
    ],
  });
});
