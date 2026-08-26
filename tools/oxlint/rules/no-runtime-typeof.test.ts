import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const error = { messageId: "runtimeTypeof" };
const allowInTypeGuards = [{ allowInTypeGuards: true }];

test("rejects runtime typeof narrowing with an optional type-guard exception", () => {
  new RuleTester().run("no-runtime-typeof", noRuntimeTypeofRule, {
    valid: [
      {
        filename: "src/telemetry/config.ts",
        code: "type ExporterConfig = typeof exporterConfigDefaults;",
      },
      {
        filename: "src/telemetry/guard.ts",
        code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
        options: allowInTypeGuards,
      },
      {
        filename: "src/telemetry/assert.ts",
        code: 'function assertString(value: unknown): asserts value is string { if (typeof value !== "string") throw new Error(); }',
        options: allowInTypeGuards,
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/narrow.ts",
        code: 'if (typeof value === "string") { emit(value); }',
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/strict-guard.ts",
        code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
        errors: [error],
        output: null,
      },
      {
        filename: "src/telemetry/parser.ts",
        code: 'function parse(value: unknown): string { if (typeof value !== "string") throw new Error(); return value; }',
        options: allowInTypeGuards,
        errors: [error],
        output: null,
      },
    ],
  });
});
