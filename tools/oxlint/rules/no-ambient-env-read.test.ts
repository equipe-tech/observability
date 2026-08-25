import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noAmbientEnvReadRule } from "./no-ambient-env-read.ts";

test("requires the environment to be decoded at the boundary", () => {
  new RuleTester().run("no-ambient-env-read", noAmbientEnvReadRule, {
    valid: [
      {
        filename: "src/node/Runtime.ts",
        code: "const layer = layerFromEnv(env ?? process.env);",
      },
      {
        filename: "src/cli/CredentialsStore.ts",
        code: "const environment = decodeCredentialsEnvironment(process.env);",
      },
      {
        filename: "packages/cli/test/Cli.bun.test.ts",
        code: "const home = process.env.OBSERVABILITY_HOME;",
      },
      {
        filename: "scripts/package-smoke.ts",
        code: 'const user = process.env["USER"];',
      },
    ],
    invalid: [
      {
        filename: "src/node/Runtime.ts",
        code: "const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;",
        errors: [{ messageId: "ambientEnvRead" }],
        output: null,
      },
      {
        filename: "src/node/Runtime.ts",
        code: 'const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];',
        errors: [{ messageId: "ambientEnvRead" }],
        output: null,
      },
      {
        filename: "src/node/Runtime.ts",
        code: "const { OTEL_SERVICE_NAME } = process.env;",
        errors: [{ messageId: "ambientEnvRead" }],
        output: null,
      },
    ],
  });
});
