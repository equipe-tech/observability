import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { taggedErrorRequiresMessageRule } from "./tagged-error-requires-message.ts";

test("requires a message field on tagged error declarations", () => {
  new RuleTester().run("tagged-error-requires-message", taggedErrorRequiresMessageRule, {
    valid: [
      {
        filename: "src/telemetry/errors.ts",
        code: 'export class IngestError extends Schema.TaggedError<IngestError>()("IngestError", { code: Schema.Literal("OBS_INGEST_FAILED"), message: Schema.String }) {}',
      },
      {
        filename: "src/telemetry/errors.ts",
        code: 'export class IngestError extends Schema.TaggedError<IngestError>()("IngestError", { ...baseFields }) {}',
      },
      {
        filename: "src/telemetry/errors.ts",
        code: 'export class IngestError extends TaggedError<IngestError>()("IngestError", { message: Schema.String }) {}',
      },
      {
        filename: "src/telemetry/errors.ts",
        code: 'export class Dataset extends Schema.Class<Dataset>("Dataset")({ name: Schema.String }) {}',
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/errors.ts",
        code: 'export class IngestError extends Schema.TaggedError<IngestError>()("IngestError", { code: Schema.Literal("OBS_INGEST_FAILED") }) {}',
        errors: [{ messageId: "requiresMessage" }],
        output: null,
      },
      {
        filename: "src/telemetry/errors.ts",
        code: 'const IngestError = class extends Schema.TaggedError<never>()("IngestError", { cause: Schema.Defect() }) {};',
        errors: [{ messageId: "requiresMessage" }],
        output: null,
      },
    ],
  });
});
