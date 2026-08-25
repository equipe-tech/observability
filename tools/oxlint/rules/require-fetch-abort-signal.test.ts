import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { requireFetchAbortSignalRule } from "./require-fetch-abort-signal.ts";

test("requires fetch calls to pass an abort signal", () => {
  new RuleTester().run("require-fetch-abort-signal", requireFetchAbortSignalRule, {
    valid: [
      {
        filename: "src/telemetry/exporter.ts",
        code: 'fetch(endpoint, { method: "POST", body, signal });',
      },
      {
        filename: "src/telemetry/exporter.ts",
        code: "fetch(url, { ...init, signal });",
      },
      {
        filename: "src/telemetry/exporter.ts",
        code: "client.fetch(url);",
      },
      {
        filename: "packages/telemetry/test/support/axiom.ts",
        code: "fetch(url);",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/exporter.ts",
        code: "fetch(url);",
        errors: [{ messageId: "missingSignal" }],
        output: null,
      },
      {
        filename: "src/telemetry/exporter.ts",
        code: "fetch(url, init);",
        errors: [{ messageId: "missingSignal" }],
        output: null,
      },
      {
        filename: "src/telemetry/exporter.ts",
        code: 'fetch(url, { method: "POST", body });',
        errors: [{ messageId: "missingSignal" }],
        output: null,
      },
    ],
  });
});
