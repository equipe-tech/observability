import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noServiceConstructorImportsRule } from "./no-service-constructor-imports.ts";

test("rejects service constructor imports outside tests", () => {
  new RuleTester().run("no-service-constructor-imports", noServiceConstructorImportsRule, {
    valid: [
      {
        filename: "src/telemetry/emit.test.ts",
        code: 'import { makeTelemetryDrain } from "./telemetry-drain.ts";',
      },
      {
        filename: "src/telemetry/emit.ts",
        code: 'import { TelemetryDrain } from "./telemetry-drain.ts";',
      },
      {
        filename: "src/telemetry/emit.ts",
        code: 'import { makeRequest } from "some-http-package";',
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/emit.ts",
        code: 'import { makeTelemetryDrain } from "./telemetry-drain.ts";',
        errors: [{ messageId: "serviceConstructorImport" }],
        output: null,
      },
    ],
  });
});
