import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noRecordTypeRule } from "./no-record-type.ts";

test("requires named domain types instead of Record", () => {
  new RuleTester().run("no-record-type", noRecordTypeRule, {
    valid: [
      {
        filename: "src/telemetry/dataset.ts",
        code: "interface DatasetNames { readonly logs: DatasetName; readonly traces: DatasetName }",
      },
      {
        filename: "src/telemetry/vendor.ts",
        code: "type VendorRecord = Vendor.Record<string>;",
      },
    ],
    invalid: [
      {
        filename: "src/telemetry/unparsed.ts",
        code: "type Attributes = Record<string, unknown>;",
        errors: [{ messageId: "recordType" }],
        output: null,
      },
      {
        filename: "src/telemetry/labels.ts",
        code: 'const labels: Record<"env" | "service", string> = values;',
        errors: [{ messageId: "recordType" }],
        output: null,
      },
    ],
  });
});
