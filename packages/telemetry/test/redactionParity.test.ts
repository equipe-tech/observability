import { assert, describe, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import {
  collectorBlockedKeyPattern,
  collectorBlockedValuePatterns,
} from "../src/RedactionPolicy.ts";

const assetPaths = [
  "packages/cli/src/assets/local.yaml",
  "packages/cli/src/assets/production.yaml",
];

const occurrences = (source: string, value: string): number => source.split(value).length - 1;

const collectorPattern = (source: string): RegExp => {
  const insensitive = source.startsWith("(?i)");
  const dotAll = source.startsWith("(?s)");
  const normalized = source.replace(/^\(\?[is]\)/, "").replaceAll("[[:space:]]", "\\s");
  return new RegExp(normalized, `${insensitive ? "i" : ""}${dotAll ? "s" : ""}`);
};

const behaviouralCases = [
  "Bearer marker",
  "sk_marker",
  "eyJheader.eyJpayload.signature",
  "person@example.com",
  "-----BEGIN PRIVATE KEY-----marker-----END PRIVATE KEY-----",
];

const collectorParityAllowances = ["nested-json-sensitive-key"];

describe("browser and Collector redaction parity", () => {
  it("discriminates-collector-behavioural-parity", () => {
    for (const value of behaviouralCases) {
      assert.isTrue(
        collectorBlockedValuePatterns.some((source) => collectorPattern(source).test(value)),
      );
    }
    assert.deepStrictEqual(collectorParityAllowances, ["nested-json-sensitive-key"]);
  });
  for (const assetPath of assetPaths) {
    it(`discriminates-collector-behavioural-parity in ${assetPath}`, () => {
      const asset = readFileSync(assetPath, "utf8");
      assert.strictEqual(occurrences(asset, `- "${collectorBlockedKeyPattern}"`), 1);
      let previousIndex = -1;
      for (const pattern of collectorBlockedValuePatterns) {
        const blockedValue = `- "${pattern}"`;
        const index = asset.indexOf(blockedValue);
        assert.isAbove(index, previousIndex);
        previousIndex = index;
        assert.strictEqual(occurrences(asset, pattern), 3);
      }
      const transform = asset.slice(
        asset.indexOf("  transform/redact:"),
        asset.indexOf("  redaction/sensitive:"),
      );
      const trace = transform.slice(
        transform.indexOf("trace_statements:"),
        transform.indexOf("log_statements:"),
      );
      const logs = transform.slice(transform.indexOf("log_statements:"));
      const vocabulary = collectorBlockedKeyPattern.replace("(?:[._-]|[A-Z0-9]|$)", "");
      assert.include(trace, vocabulary);
      assert.include(logs, vocabulary);
      for (const pattern of collectorBlockedValuePatterns) {
        assert.include(trace, pattern);
        assert.include(logs, pattern);
      }
      assert.match(
        asset,
        /traces:[\s\S]*?processors:[\s\S]*?transform\/redact, redaction\/sensitive[\s\S]*?logs:/,
      );
      assert.match(
        asset,
        /logs:[\s\S]*?processors:[\s\S]*?transform\/redact, redaction\/sensitive[\s\S]*?metrics:/,
      );
      assert.match(asset, /metrics:[\s\S]*?processors:.*redaction\/sensitive/);
    });
  }
});
