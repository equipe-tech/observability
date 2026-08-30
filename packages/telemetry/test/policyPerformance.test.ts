import { assert, describe, it } from "vite-plus/test";
import { Effect, Exit } from "effect";
import { maxEventsPerBatch, maxFieldsPerEvent, maxFieldValueLength } from "../src/BrowserEvents.ts";
import { ingestBrowserEvents } from "../src/node/index.ts";
import { baseDataPolicy, parseDataPolicy } from "../src/policy/DataPolicy.ts";
import { sanitizeText, transformSignalFields } from "../src/policy/PolicyTransform.ts";
import * as Testing from "../src/testing/index.ts";

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

  it("rejects the bounded catastrophic report patterns without executing them", async () => {
    const patterns = [
      "[a-z]{0,200}[a-z]{0,200}[a-z]{0,200}x",
      "[A-Za-z0-9]{0,64}[A-Za-z0-9]{0,64}[A-Za-z0-9]{0,64}[A-Za-z0-9]{0,64}x",
    ];
    for (const pattern of patterns) {
      const started = performance.now();
      const failure = await Effect.runPromise(
        Effect.flip(
          parseDataPolicy({ attributes: {}, blockedKeys: [], blockedValuePatterns: [pattern] }),
        ),
      );
      assert.strictEqual(failure.issues[0]?.code, "OBS_POLICY_UNSAFE_BLOCKED_VALUE_PATTERN");
      assert.isBelow(performance.now() - started, 100);
      assert.notInclude(JSON.stringify(failure), pattern);
    }
  });

  it("bounds maximum browser batches through direct ingest", async () => {
    const marker = crypto.randomUUID().replaceAll("-", "");
    const suffix = `&password=${marker}`;
    const fields = Object.fromEntries(
      Array.from({ length: maxFieldsPerEvent }, (_, index) => [
        `field.f${index}`,
        `${"a".repeat(maxFieldValueLength - suffix.length)}${suffix}`,
      ]),
    );
    assert.lengthOf(Object.keys(fields), maxFieldsPerEvent);
    const events = Array.from({ length: maxEventsPerBatch }, (_, index) => ({
      id: `evt-${index}`,
      name: "batch.maximum",
      occurredAt: 1,
      fields,
    }));
    const started = performance.now();
    const result = await Effect.runPromise(
      Testing.run(ingestBrowserEvents({ version: 1, events })),
    );
    const timing = performance.now() - started;
    assert.deepStrictEqual(
      result.exit,
      Exit.succeed({
        accepted: maxEventsPerBatch,
        redacted: maxEventsPerBatch * maxFieldsPerEvent,
        dropped: 0,
      }),
    );
    assert.lengthOf(result.telemetry.logs, maxEventsPerBatch);
    for (const log of result.telemetry.logs) {
      const admitted = [...log.attributes.keys()].filter((key) => key.startsWith("field.f"));
      assert.lengthOf(admitted, maxFieldsPerEvent);
    }
    assert.notInclude(JSON.stringify(result.telemetry), marker);
    assert.isBelow(timing, 5_000);
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
