import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noServiceConstructorImportsRule } from "./no-service-constructor-imports.ts";

const error = { messageId: "serviceConstructorImport" };

test("rejects local service constructor imports outside test file suffixes", () => {
  new RuleTester().run("no-service-constructor-imports", noServiceConstructorImportsRule, {
    valid: [
      {
        filename: "src/telemetry/emit.test.ts",
        code: 'import { makeTelemetryDrain } from "./telemetry-drain.ts";',
      },
      {
        filename: "src/telemetry/emit.spec.tsx",
        code: 'import { makeTelemetryDrain } from "../telemetry-drain.ts";',
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
        errors: [error],
        output: null,
      },
      {
        filename: "src/tests/runtime.ts",
        code: 'import { makeTelemetryDrain as createTelemetryDrain } from "../telemetry-drain.ts";',
        errors: [error],
        output: null,
      },
      {
        filename: "C:\\src\\telemetry\\runtime.ts",
        code: 'import { makeTelemetryDrain } from "./telemetry-drain.ts";',
        errors: [error],
        output: null,
      },
    ],
  });
});
