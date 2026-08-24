import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

test("rejects runtime typeof narrowing and allows type-position typeof", () => {
  new RuleTester().run("no-runtime-typeof", noRuntimeTypeofRule, {
    valid: [
      {
        filename: "src/telemetry/config.ts",
        code: "type ExporterConfig = typeof exporterConfigDefaults;",
      },
      {
        filename: "src/telemetry/parse.ts",
        code: "const endpoint = parseEndpoint(candidate);",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/narrow.ts",
        code: 'if (typeof value === "string") { emit(value); }',
        errors: [{ messageId: "runtimeTypeof" }],
        output: null,
      },
    ],
  });
});
