import { assert } from "@effect/vitest";
import type { canarySensitiveValues } from "./canary.ts";

export type CanaryMetricPolicyEvidence = {
  readonly content: string;
  readonly runId: string;
};

const forbiddenMetricLabelKeys = [
  "canary.probe_a",
  "canary.probe_b",
  "canary.probe_c",
  "canary.probe_d",
  "canary.probe_e",
  "tool.tokenizer",
  "docs.documentation",
] as const;

export const assertCanaryMetricPolicy = (
  evidence: CanaryMetricPolicyEvidence,
  sensitive: ReturnType<typeof canarySensitiveValues>,
): void => {
  assert.include(evidence.content, "canary.run_id");
  assert.include(evidence.content, evidence.runId);
  for (const key of forbiddenMetricLabelKeys) {
    assert.notInclude(evidence.content, key);
  }
  for (const value of [...sensitive.leakMarkers, ...sensitive.preservedValues]) {
    assert.notInclude(evidence.content, value);
  }
  assert.notInclude(evidence.content, "****");
  assert.notInclude(evidence.content, "[REDACTED]");
};
