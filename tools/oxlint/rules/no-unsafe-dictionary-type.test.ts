import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";

const error = { messageId: "unsafeDictionary" };

test("rejects unsafe index and mapped value contracts without duplicating Record policy", () => {
  new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
    "no-unsafe-dictionary-type",
    noUnsafeDictionaryTypeRule,
    {
      valid: [
        "type Attributes = { [key: string]: string | number | boolean };",
        "interface Attributes { [key: string]: AttributeValue }",
        "type Attributes = { [Key in AttributeName]: AttributeValue };",
        "type Attributes = Record<string, unknown>;",
        "type Owner = { readonly id: string }; type Attributes = { [key: string]: Owner };",
      ],
      invalid: [
        {
          code: "type Attributes = { [key: string]: unknown };",
          errors: [error],
          output: null,
        },
        {
          code: "interface Attributes { [key: string]: object }",
          errors: [error],
          output: null,
        },
        {
          code: "type Attributes = { [Key in string]: any };",
          errors: [error],
          output: null,
        },
        {
          code: "type Escape = unknown; type Attributes = { [key: string]: Escape };",
          errors: [error],
          output: null,
        },
        {
          code: "interface Escape {} type Attributes = { [key: string]: Escape };",
          errors: [error],
          output: null,
        },
        {
          code: "type Attributes = { [key: string]: string | unknown };",
          errors: [error],
          output: null,
        },
      ],
    },
  );
});
