import { expect, test } from "vite-plus/test";
import type { BrowserTelemetryClientBatch } from "@equipe-tech/observability/browser/client";
import { definePolicy } from "@equipe-tech/observability/policy";
import { createBrowserObservability } from "../src/index.ts";

test("captures a React root defect in Chromium through the production entrypoint", async () => {
  const batches: Array<BrowserTelemetryClientBatch> = [];
  const observability = createBrowserObservability({
    service: { name: "browser-app", version: "0.3.0", environment: "test" },
    policy: definePolicy({
      attributes: {
        "error.origin": { classification: "internal", required: true, metricLabel: false },
      },
      blockedKeys: [],
      blockedValuePatterns: [],
    }),
    sentry: { disabled: true },
    events: {
      flushIntervalMs: 60_000,
      transport: async (batch) => {
        batches.push(batch);
      },
    },
  });
  observability.reactRootOptions.onUncaughtError(new Error("render failed"), {});
  await observability.flush();
  expect(observability.installed).toBe(true);
  expect(batches).toHaveLength(1);
  expect(batches[0]?.events[0]?.name).toBe("browser.error");
  expect(batches[0]?.events[0]?.fields["error.origin"]).toBe("react.uncaught");
  await observability.dispose();
});
