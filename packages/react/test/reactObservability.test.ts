import { assert, describe, it } from "vite-plus/test";
import type { BrowserTelemetryClientBatch } from "@equipe-tech/observability/browser/client";
import { definePolicy } from "@equipe-tech/observability/policy";
import {
  BrowserObservabilityError,
  createBrowserObservability,
  runBrowserDeliveryCanary,
  type BrowserEventHost,
} from "../src/index.ts";

const policy = definePolicy({
  attributes: {
    "error.origin": { classification: "internal", required: true, metricLabel: false },
    "react.component_stack": { classification: "sensitive", required: false, metricLabel: false },
  },
  blockedKeys: [],
  blockedValuePatterns: [],
});

const recordingHost = () => {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const host: BrowserEventHost = {
    addEventListener: (name, listener) => {
      const current = listeners.get(name) ?? new Set();
      current.add(listener);
      listeners.set(name, current);
    },
    removeEventListener: (name, listener) => {
      listeners.get(name)?.delete(listener);
    },
  };
  return { host, listeners };
};

const service = { name: "browser-app", version: "0.3.0", environment: "test" };

describe("React browser observability", () => {
  it("shares one defect identity and removes every global listener", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const fixture = recordingHost();
    const observability = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { disabled: true },
      events: {
        flushIntervalMs: 60_000,
        transport: async (batch) => {
          batches.push(batch);
        },
      },
    });

    const error = new Error("render failed");
    const first = observability.defects.report({ error, origin: "react.uncaught" });
    const second = observability.defects.report({ error, origin: "window.error" });
    assert.strictEqual(first.kind, "recorded");
    assert.strictEqual(second.kind, "deduplicated");
    if (first.kind !== "recorded") throw new Error("Expected a recorded defect");
    assert.match(first.eventId, /^[0-9a-f]{32}$/);
    assert.strictEqual(first.destinations.sentry, "disabled");
    await observability.flush();
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0]?.events.length, 1);
    assert.strictEqual(batches[0]?.events[0]?.id, first.eventId);
    assert.strictEqual(batches[0]?.events[0]?.error?.type, "Error");
    assert.strictEqual(batches[0]?.events[0]?.fields["error.origin"], "react.uncaught");

    await observability.dispose();
    assert.strictEqual(fixture.listeners.get("error")?.size, 0);
    assert.strictEqual(fixture.listeners.get("unhandledrejection")?.size, 0);
    assert.strictEqual(fixture.listeners.get("pagehide")?.size, 0);
  });

  it("rejects a second active installation on the same host", async () => {
    const fixture = recordingHost();
    const first = createBrowserObservability({ service, policy, host: fixture.host });
    try {
      createBrowserObservability({ service, policy, host: fixture.host });
      assert.fail("Expected the second installation to fail");
    } catch (cause: unknown) {
      assert.instanceOf(cause, BrowserObservabilityError);
      if (cause instanceof BrowserObservabilityError) {
        assert.strictEqual(cause.code, "OBS_REACT_ALREADY_INSTALLED");
      }
    }
    await first.dispose();
    const replacement = createBrowserObservability({ service, policy, host: fixture.host });
    await replacement.dispose();
  });

  it("rejects local canary endpoints without making a request", async () => {
    try {
      await runBrowserDeliveryCanary({
        endpoint: new URL("https://localhost/_telemetry/events"),
      });
      assert.fail("Expected the local endpoint to fail");
    } catch (cause: unknown) {
      assert.instanceOf(cause, BrowserObservabilityError);
      if (cause instanceof BrowserObservabilityError) {
        assert.strictEqual(cause.code, "OBS_REACT_CANARY_ENDPOINT_INVALID");
      }
    }
  });
});
