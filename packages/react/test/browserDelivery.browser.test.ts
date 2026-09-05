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
  resource: Schema.optional(
    Schema.Struct({
      serviceName: Schema.String,
      serviceVersion: Schema.String,
      environment: Schema.String,
    }),
  ),
  events: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      error: Schema.optional(
        Schema.Struct({ type: Schema.String, message: Schema.String, retryable: Schema.Boolean }),
      ),
    }),
  ),
  spans: Schema.optional(
    Schema.Array(
      Schema.Struct({
        traceId: Schema.String,
        spanId: Schema.String,
        parentSpanId: Schema.optional(Schema.String),
        name: Schema.String,
      }),
    ),
  ),
  metrics: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Number })),
  ),
});

test("keeps trace groups complete without starving unrelated browser signals", async () => {
  const initialEventBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/events")).json(),
  ).length;
  const observability = createBrowserObservability({
    service: { name: "browser-app", version: "0.3.0", environment: "test" },
    policy: definePolicy({ attributes: {}, blockedKeys: [], blockedValuePatterns: [] }),
    metrics: true,
    sentry: { disabled: true },
    events: { flushIntervalMs: 60_000, maxBatchSize: 1 },
  });
  const root = observability.traces.startSpan("page.load");
  const child = observability.traces.startSpan("react.render", {}, root.context);
  child.end();
  observability.events.emit("page.rendered", {}, child.context);
  observability.events.emit("unrelated.event");
  observability.metrics.counter("unrelated.counter").add(1);

  await observability.flush();
  const firstBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/events")).json(),
  ).slice(initialEventBodies);
  const firstBatches = firstBodies.map((body) =>
    Schema.decodeUnknownSync(EventBatch)(JSON.parse(body)),
  );
  expect(firstBatches.flatMap((batch) => batch.events).map((event) => event.name)).toEqual([
    "unrelated.event",
  ]);
  expect(firstBatches.flatMap((batch) => batch.metrics ?? [])).toHaveLength(1);
  expect(firstBatches.flatMap((batch) => batch.spans ?? [])).toHaveLength(0);

  root.end();
  await observability.flush();
  const finalBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/events")).json(),
  ).slice(initialEventBodies);
  const finalBatches = finalBodies.map((body) =>
    Schema.decodeUnknownSync(EventBatch)(JSON.parse(body)),
  );
  const traceBatch = finalBatches.find((batch) =>
    batch.spans?.some((span) => span.name === "page.load"),
  );
  expect(traceBatch?.spans).toHaveLength(2);
  expect(traceBatch?.events.map((event) => event.name)).toEqual(["page.rendered"]);

  observability.events.emit("stale.correlated", {}, child.context);
  observability.events.emit("after.stale");
  await observability.flush();
  await observability.dispose();
  const disposedBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/events")).json(),
  ).slice(initialEventBodies);
  const disposedBatches = disposedBodies.map((body) =>
    Schema.decodeUnknownSync(EventBatch)(JSON.parse(body)),
  );
  expect(disposedBatches.flatMap((batch) => batch.events).map((event) => event.name)).toContain(
    "after.stale",
  );
  expect(disposedBatches.flatMap((batch) => batch.events).map((event) => event.name)).not.toContain(
    "stale.correlated",
  );
});

test("delivers one canonical defect through production browser entrypoints", async () => {
  const initialEventBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/events")).json(),
  ).length;
  const initialSentryBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/sentry")).json(),
  ).length;
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
    metrics: true,
    sentry: { dsn: `${origin.replace("://", "://public@")}/sentry/1` },
    events: { flushIntervalMs: 60_000 },
  });
  const root = observability.traces.startSpan("page.load", { "run.id": "browser-e2e" });
  const render = observability.traces.startSpan(
    "react.render",
    { "run.id": "browser-e2e" },
    root.context,
  );
  observability.events.emit("page.rendered", { "run.id": "browser-e2e" }, render.context);
  observability.metrics.counter("react.render.count").add(1, {
    "run.id": "browser-e2e",
  });
  render.end();
  root.end();
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
  ).slice(initialEventBodies);
  const sentryBodies = Schema.decodeUnknownSync(StringArray)(
    await (await fetch("/_inspect/sentry")).json(),
  ).slice(initialSentryBodies);
  expect(eventBodies).toHaveLength(1);
  expect(sentryBodies).toHaveLength(1);
  const batch = Schema.decodeUnknownSync(EventBatch)(JSON.parse(eventBodies[0] ?? ""));
  expect(batch.resource).toEqual({
    serviceName: "browser-app",
    serviceVersion: "0.3.0",
    environment: "test",
  });
  expect(batch.events).toHaveLength(2);
  expect(batch.events.find((event) => event.id === outcome.eventId)?.error?.message).not.toContain(
    "secret-token",
  );
  expect(batch.spans).toHaveLength(2);
  const rootSpan = batch.spans?.find((span) => span.name === "page.load");
  const renderSpan = batch.spans?.find((span) => span.name === "react.render");
  expect(renderSpan?.traceId).toBe(rootSpan?.traceId);
  expect(renderSpan?.parentSpanId).toBe(rootSpan?.spanId);
  expect(batch.metrics).toHaveLength(1);
  expect(batch.metrics?.[0]?.name).toBe("react.render.count");
  expect(batch.metrics?.[0]?.value).toBe(1);
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
