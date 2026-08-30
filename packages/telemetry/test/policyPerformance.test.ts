import { assert, describe, it } from "vite-plus/test";
import { maxEventsPerBatch, maxFieldsPerEvent, maxFieldValueLength } from "../src/BrowserEvents.ts";
import { baseDataPolicy } from "../src/policy/DataPolicy.ts";
import { sanitizeText, transformSignalFields } from "../src/policy/PolicyTransform.ts";

const elapsed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
};

const measure = (run: () => void): number => median(Array.from({ length: 5 }, () => elapsed(run)));

describe("policy sanitizer performance", () => {
  it("scales within bounded linear limits through 128 KB", () => {
    const sizes = [8_192, 32_768, 65_536, 131_072];
    const timings = sizes.map((size) =>
      measure(() => {
        sanitizeText(
          baseDataPolicy,
          `${"a@".repeat(Math.floor(size / 2))}password=value`,
          "defect",
        );
      }),
    );
    for (const timing of timings) assert.isBelow(timing, 1_000);
    for (let index = 1; index < timings.length; index += 1) {
      assert.isAtMost(timings[index] ?? 0, (timings[index - 1] ?? 0) * 4 + 25);
    }
  });

  it("bounds maximum browser batches", () => {
    const fields = Object.fromEntries(
      Array.from({ length: maxFieldsPerEvent }, (_, index) => [
        `field.${index}`,
        `${"a@".repeat(maxFieldValueLength / 2 - 8)}password=value`,
      ]),
    );
    const timing = measure(() => {
      for (let index = 0; index < maxEventsPerBatch; index += 1) {
        transformSignalFields(baseDataPolicy, "browser-ingest", fields);
      }
    });
    assert.isBelow(timing, 2_000);
  });

  it("truncates before scanning every server text bound", () => {
    const surfaces = ["event", "log", "span", "defect", "resource"] as const;
    for (const surface of surfaces) {
      const decision = transformSignalFields(baseDataPolicy, surface, {
        "request.detail": `${"x".repeat(140_000)} password=outside`,
      });
      assert.notInclude(String(decision.value["request.detail"]), "outside");
      assert.deepInclude(decision.redactions, { rule: "bounds", action: "truncated", surface });
    }
  });
});
