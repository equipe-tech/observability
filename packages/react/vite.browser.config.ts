import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@equipe-tech/observability-sentry/browser",
        replacement: `${root}/packages/sentry/src/browser/index.ts`,
      },
      {
        find: "@equipe-tech/observability/browser/client",
        replacement: `${root}/packages/telemetry/src/browser/client.ts`,
      },
      {
        find: "@equipe-tech/observability/policy",
        replacement: `${root}/packages/telemetry/src/policy/entrypoint.ts`,
      },
    ],
  },
  test: {
    include: ["packages/react/test/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
