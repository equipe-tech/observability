import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  fmt: {},
  resolve: {
    alias: [
      {
        find: "@equipe-tech/observability/browser/client",
        replacement: `${root}packages/telemetry/src/browser/client.ts`,
      },
      {
        find: "@equipe-tech/observability/browser",
        replacement: `${root}packages/telemetry/src/browser/index.ts`,
      },
      {
        find: "@equipe-tech/observability/effect",
        replacement: `${root}packages/telemetry/src/effect/index.ts`,
      },
      {
        find: "@equipe-tech/observability/metrics",
        replacement: `${root}packages/telemetry/src/Metrics.ts`,
      },
      {
        find: "@equipe-tech/observability/testing",
        replacement: `${root}packages/telemetry/src/testing/index.ts`,
      },
      {
        find: "@equipe-tech/observability/node",
        replacement: `${root}packages/telemetry/src/node/index.ts`,
      },
      {
        find: "@equipe-tech/observability-nestjs",
        replacement: `${root}packages/nestjs/src/index.ts`,
      },
      {
        find: "@equipe-tech/observability",
        replacement: `${root}packages/telemetry/src/index.ts`,
      },
    ],
  },
  lint: {
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop-plugin.ts" },
      { name: "effect", specifier: "./tools/oxlint/effect-plugin.ts" },
      { name: "hygiene", specifier: "./tools/oxlint/hygiene-plugin.ts" },
    ],
    rules: {
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-record-type": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "effect/no-ambient-env-read": "error",
      "effect/no-bare-error": "error",
      "effect/no-service-constructor-imports": "error",
      "effect/require-fetch-abort-signal": "error",
      "effect/tagged-error-requires-message": "error",
      "hygiene/no-async-context-enter-with": "error",
      "hygiene/no-foreign-directive": "error",
      "hygiene/no-vacuous-throw-assertion": "error",
      "hygiene/no-void-operator": "error",
      "hygiene/require-suppression-reason": "error",
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}": "vp check --fix",
    "*.{css,html,json,jsonc,md,mdx,toml,yaml,yml}": "vp fmt --write",
  },
  test: {
    exclude: ["**/node_modules/**", "**/*.bun.test.ts", "repos/**"],
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
  },
});
