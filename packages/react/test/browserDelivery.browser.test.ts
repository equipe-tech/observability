import { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { browserEnvelopeVersion } from "@equipe-tech/observability/browser/client";
import { definePolicy } from "@equipe-tech/observability/policy";
import {
  createBrowserObservability,
  type BrowserEventHost,
} from "@equipe-tech/observability-react";

const StringArray = Schema.Array(Schema.String);
const EventBatch = Schema.Struct({
  version: Schema.Literal(browserEnvelopeVersion),
  events: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      error: Schema.optional(
        Schema.Struct({ type: Schema.String, message: Schema.String, retryable: Schema.Boolean }),
      ),
    }),
  ),
});

test("delivers one canonical defect through production browser entrypoints", async () => {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const host: BrowserEventHost = {
    addEventListener: (name, listener) => {
      const current = listeners.get(name) ?? new Set();
      current.add(listener);
      listeners.set(name, current);
      globalThis.addEventListener(name, listener);
    },
    removeEventListener: (name, listener) => {
      listeners.get(name)?.delete(listener);
      globalThis.removeEventListener(name, listener);
    },
  };
  const origin = new URL(import.meta.url).origin;
  const observability = createBrowserObservability({
    service: { name: "browser-app", version: "0.3.0", environment: "test" },
    policy: definePolicy({
      attributes: {
        "error.origin": { classification: "internal", required: true, metricLabel: false },
      },
      blockedKeys: [],
      blockedValuePatterns: ["secret-[a-z]+"],
    }),
    host,
    sentry: { dsn: `${origin.replace("://", "://public@")}/sentry/1` },
    events: { flushIntervalMs: 60_000 },
  });
  const defect = new Error("render secret-token failed");
  const outcome = observability.defects.report({
    error: defect,
    origin: "react.uncaught",
  });
  const duplicateEvent = new ErrorEvent("error", { error: defect, message: defect.message });
  for (const listener of listeners.get("error") ?? []) listener(duplicateEvent);
  expect(outcome.kind).toBe("recorded");
  if (outcome.kind !== "recorded") throw new Error("Expected one recorded defect");
  await observability.flush();
  const eventBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/events")).json(),
  );
  const sentryBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/sentry")).json(),
  );
  expect(eventBodies).toHaveLength(1);
  expect(sentryBodies).toHaveLength(1);
  const batch = Schema.decodeUnknownSync(EventBatch)(JSON.parse(eventBodies[0] ?? ""));
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]?.id).toBe(outcome.eventId);
  expect(batch.events[0]?.error?.message).not.toContain("secret-token");
  expect(sentryBodies[0]).toContain(outcome.eventId);
  expect(sentryBodies[0]).toContain('"release":"0.3.0"');
  expect(sentryBodies[0]).not.toContain("secret-token");
  expect(sentryBodies[0]).not.toContain('"replay_id"');
  expect(sentryBodies[0]).not.toContain('"session"');
  expect(sentryBodies[0]).not.toContain('"transaction"');
  await observability.dispose();
  expect(listeners.get("error")?.size).toBe(0);
  expect(listeners.get("unhandledrejection")?.size).toBe(0);
  expect(listeners.get("pagehide")?.size).toBe(0);
});
