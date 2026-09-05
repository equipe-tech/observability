import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  BrowserTelemetryClientDeliveryError,
  BrowserTelemetryClientShutdownError,
  browserBatchByteLength,
  browserRequestByteBudget,
  createBrowserTelemetryClient,
  maxEventNameLength,
  maxEventsPerBatch,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
  type BrowserTelemetryClientBatch,
  type BrowserTelemetryClientTransport,
} from "../src/browser/index.ts";
import { definePolicy, parseDataPolicy } from "../src/policy/DataPolicy.ts";
import { transformSignalFields } from "../src/policy/PolicyTransform.ts";
import { sensitiveFieldReplacement, sensitiveTextReplacement } from "../src/RedactionPolicy.ts";

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} => {
  let complete = (): void => undefined;
  let fail = (_error: Error): void => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: complete, reject: fail };
};

describe("browser telemetry client", () => {
  it("lets an error-less v1 decoder strip the additive error member", () => {
    const OldBatch = Schema.Struct({
      version: Schema.Literal(1),
      events: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          occurredAt: Schema.Number,
          fields: Schema.Struct({}),
        }),
      ),
    });
    const decoded = Schema.decodeUnknownSync(OldBatch)({
      version: 1,
      events: [
        {
          id: "new",
          name: "browser.error",
          occurredAt: 1,
          fields: {},
          error: { type: "TypeError", message: "failed", retryable: false },
        },
      ],
    });
    expect(decoded).toEqual({
      version: 1,
      events: [{ id: "new", name: "browser.error", occurredAt: 1, fields: {} }],
    });
  });

  it("applies an optional compiled policy before queue insertion and emits typed defects", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const policy = definePolicy({
      attributes: {
        "error.origin": { classification: "internal", required: true, metricLabel: false },
        "customer.email": { classification: "sensitive", required: false, metricLabel: false },
      },
      blockedKeys: [],
      blockedValuePatterns: [],
    });
    const compiledPolicy = Effect.runSync(parseDataPolicy(policy));
    const client = createBrowserTelemetryClient({
      policy: (fields) => transformSignalFields(compiledPolicy, "browser-ingest", fields).value,
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    client.emitDefect({
      id: "0123456789abcdef0123456789abcdef",
      name: "browser.error",
      error: { type: "TypeError", message: "failed", retryable: false },
      fields: {
        "error.origin": "manual",
        "customer.email": "person@example.com",
      },
    });
    await client.flush();
    expect(batches[0]?.events[0]).toEqual({
      id: "0123456789abcdef0123456789abcdef",
      name: "browser.error",
      occurredAt: expect.any(Number),
      fields: {
        "error.origin": "manual",
        "customer.email": sensitiveFieldReplacement,
      },
      error: { type: "TypeError", message: "failed", retryable: false },
    });
    await client.dispose();
  });

  it("applies blocked patterns and classifications to error type before transport", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const classifiedPolicy = Effect.runSync(
      parseDataPolicy(
        definePolicy({
          attributes: {
            "error.type": { classification: "sensitive", required: false, metricLabel: false },
            "error.message": { classification: "internal", required: false, metricLabel: false },
          },
          blockedKeys: [],
          blockedValuePatterns: ["secret-[a-z]+"],
        }),
      ),
    );
    const client = createBrowserTelemetryClient({
      policy: (fields) => transformSignalFields(classifiedPolicy, "browser-ingest", fields).value,
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    client.emitDefect({
      name: "browser.error",
      error: { type: "secret-token", message: "failed", retryable: false },
    });
    await client.flush();
    expect(batches[0]?.events[0]?.error?.type).toBe(sensitiveFieldReplacement);
    expect(JSON.stringify(batches)).not.toContain("secret-token");
    await client.dispose();
  });

  it("emits synchronously, sanitizes before transport, and retries the same batch", async () => {
    const secret = crypto.randomUUID().replaceAll("-", "");
    const batches: Array<BrowserTelemetryClientBatch> = [];
    let attempts = 0;
    const transport: BrowserTelemetryClientTransport = async (batch) => {
      batches.push(batch);
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    };
    const client = createBrowserTelemetryClient({ transport, flushIntervalMs: 60_000 });

    const result = client.emit(`checkout token=${secret}`, {
      authorization: secret,
      note: `Bearer ${secret}`,
      control: "tokenizer",
    });
    expect(result).toBeUndefined();
    expect(client.pending()).toBe(1);
    await expect(client.flush()).rejects.toThrow("offline");
    expect(client.pending()).toBe(1);
    await client.flush();
    expect(client.pending()).toBe(0);
    expect(batches[1]).toEqual(batches[0]);
    const serialized = JSON.stringify(batches);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(sensitiveFieldReplacement);
    expect(serialized).toContain(sensitiveTextReplacement);
    await client.dispose();
  });

  it("queues correlated spans and only selected metrics through the event transport", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const disabledMetrics = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    disabledMetrics.metrics.counter("ignored.count").add();
    expect(disabledMetrics.pending()).toBe(0);
    await disabledMetrics.dispose();

    let attempts = 0;
    const client = createBrowserTelemetryClient({
      metrics: true,
      transport: async (batch) => {
        batches.push(batch);
        attempts += 1;
        if (attempts === 1) throw new Error("browser signals offline");
      },
      flushIntervalMs: 60_000,
    });
    const root = client.traces.startSpan("page.load", { route: "/checkout" });
    const child = client.traces.startSpan("react.render", {}, root.context);
    client.emit("page.rendered", {}, child.context);
    client.metrics.counter("react.render.count").add(1, { route: "/checkout" });
    child.end();
    child.end({ duplicate: true });
    root.end();
    expect(client.pending()).toBe(4);
    await expect(client.flush()).rejects.toThrow("browser signals offline");
    expect(client.pending()).toBe(4);
    await client.flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(batches[0]);
    expect(batches[1]?.events[0]?.trace).toEqual(child.context);
    expect(batches[1]?.spans).toHaveLength(2);
    expect(batches[1]?.spans?.find((span) => span.name === "react.render")?.parentSpanId).toBe(
      root.context.spanId,
    );
    expect(batches[1]?.metrics?.[0]?.name).toBe("react.render.count");
    expect(client.pending()).toBe(0);
    client.traces.startSpan("route.abandoned");
    await client.dispose();
    const forced = batches
      .flatMap((batch) => batch.spans ?? [])
      .find((span) => span.name === "route.abandoned");
    expect(forced?.fields["span.forced_end"]).toBe(true);
  });

  it("waits for open ancestors and sends complete span-only trace groups", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      metrics: true,
      maxBatchSize: 1,
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    const root = client.traces.startSpan("page.load");
    const child = client.traces.startSpan("react.render", {}, root.context);
    child.end();
    client.emit("page.rendered", {}, child.context);
    client.emit("unrelated.event");
    client.metrics.counter("unrelated.counter").add(1);

    await client.flush();
    expect(batches).toHaveLength(2);
    expect(batches.flatMap((batch) => batch.events).map((event) => event.name)).toEqual([
      "unrelated.event",
    ]);
    expect(batches.flatMap((batch) => batch.metrics ?? [])).toHaveLength(1);
    expect(client.pending()).toBe(2);

    root.end();
    await client.flush();
    const traceBatch = batches.find((batch) =>
      batch.spans?.some((span) => span.name === "page.load"),
    );
    expect(traceBatch?.spans?.map((span) => span.name).toSorted()).toEqual([
      "page.load",
      "react.render",
    ]);
    expect(traceBatch?.events.map((event) => event.name)).toEqual(["page.rendered"]);
    expect(client.pending()).toBe(0);
    await client.dispose();

    const spanOnlyBatches: Array<BrowserTelemetryClientBatch> = [];
    const spanOnly = createBrowserTelemetryClient({
      maxBatchSize: 1,
      transport: async (batch) => {
        spanOnlyBatches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    const spanOnlyRoot = spanOnly.traces.startSpan("split.root");
    const spanOnlyChild = spanOnly.traces.startSpan("split.child", {}, spanOnlyRoot.context);
    spanOnlyChild.end();
    spanOnlyRoot.end();
    await spanOnly.flush();
    expect(spanOnlyBatches).toHaveLength(1);
    expect(spanOnlyBatches[0]?.spans).toHaveLength(2);
    await spanOnly.dispose();
  });

  it("drops stale correlation without starving unrelated delivery or disposal", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      metrics: true,
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    const completed = client.traces.startSpan("completed.span");
    completed.end();
    await client.flush();

    client.emit("stale.correlated", {}, completed.context);
    client.emit("unrelated.event");
    client.metrics.counter("unrelated.counter").add(1);
    await client.flush();

    expect(batches.flatMap((batch) => batch.events).map((event) => event.name)).toEqual([
      "unrelated.event",
    ]);
    expect(batches.flatMap((batch) => batch.metrics ?? []).map((metric) => metric.name)).toEqual([
      "unrelated.counter",
    ]);
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(1);
    await client.dispose();
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(1);
  });

  it("splits maximum browser inputs below the HTTP request byte budget", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    const fields = Object.fromEntries(
      Array.from({ length: maxFieldsPerEvent }, (_, index) => [
        `${String(index).padStart(2, "0")}${"界".repeat(maxFieldKeyLength - 2)}`,
        "界".repeat(maxFieldValueLength),
      ]),
    );
    for (let index = 0; index < maxEventsPerBatch; index += 1) {
      client.emit("n".repeat(maxEventNameLength), fields);
    }
    await client.flush();
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(maxEventsPerBatch);
    for (const batch of batches) {
      expect(browserBatchByteLength(batch)).toBeLessThanOrEqual(browserRequestByteBudget);
    }
    await client.dispose();
  }, 15_000);

  it("serializes only populated signals at the request budget and drains unrelated work", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const fields = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [`field.f${index}`, "\u0001".repeat(1_024)]),
    );
    fields["field.last"] = "\u0001".repeat(602);
    const client = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    client.emit("unrelated.event", fields);
    client.emit("after.large");

    await client.flush();
    await client.dispose();

    expect(batches.flatMap((batch) => batch.events).map((event) => event.name)).toEqual([
      "unrelated.event",
      "after.large",
    ]);
    expect(
      batches.every((batch) => browserBatchByteLength(batch) <= browserRequestByteBudget),
    ).toBe(true);
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(0);
  });

  it("coalesces concurrent flushes and drains events emitted during delivery", async () => {
    const firstDelivery = deferred();
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const transport: BrowserTelemetryClientTransport = async (batch) => {
      batches.push(batch);
      if (batches.length === 1) await firstDelivery.promise;
    };
    const client = createBrowserTelemetryClient({
      transport,
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
    });
    client.emit("first");
    const firstFlush = client.flush();
    const concurrentFlush = client.flush();
    expect(concurrentFlush).toBe(firstFlush);
    client.emit("second");
    firstDelivery.resolve();
    await firstFlush;
    expect(batches.map((batch) => batch.events[0]?.name)).toEqual(["first", "second"]);
    expect(client.pending()).toBe(0);
    await client.dispose();
  });

  it("settles a failed active flush and retries its queued batch during disposal", async () => {
    const active = deferred();
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
        if (batches.length === 1) await active.promise;
      },
      flushIntervalMs: 60_000,
      shutdownTimeoutMs: 200,
    });
    client.emit("active-failure");
    const flush = client.flush();
    const disposal = client.dispose();
    active.reject(new Error("active failed"));
    await expect(flush).rejects.toThrow("active failed");
    await disposal;
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(batches[0]);
    expect(client.pending()).toBe(0);
  });

  it("aborts a hung transport at the shutdown deadline with one disposal promise", async () => {
    let aborted = false;
    const client = createBrowserTelemetryClient({
      transport: (_batch, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      flushIntervalMs: 60_000,
      shutdownTimeoutMs: 20,
    });
    client.emit("hung");
    client.flush().catch(() => undefined);
    const disposal = client.dispose();
    expect(client.dispose()).toBe(disposal);
    await expect(disposal).rejects.toMatchObject({
      code: "OBS_BROWSER_EVENTS_SHUTDOWN_TIMEOUT",
      retryable: true,
      timeoutMs: 20,
    });
    expect(aborted).toBe(true);
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(1);
  });

  it("bounds disposal when a custom transport ignores abort", async () => {
    const client = createBrowserTelemetryClient({
      transport: async () => new Promise<void>(() => undefined),
      flushIntervalMs: 60_000,
      shutdownTimeoutMs: 20,
    });
    client.emit("abort-ignored");
    client.flush().catch(() => undefined);
    const startedAt = Date.now();
    await expect(client.dispose()).rejects.toBeInstanceOf(BrowserTelemetryClientShutdownError);
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(1);
  });

  it("uses a valid bounded fallback for empty names", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    client.emit("");
    await client.flush();
    expect(batches[0]?.events[0]?.name).toBe("browser.event");
    await client.dispose();
  });

  it("disposes once, flushes pending work, and is terminal", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 60_000,
    });
    client.emit("cleanup");
    const firstDispose = client.dispose();
    expect(client.dispose()).toBe(firstDispose);
    await firstDispose;
    client.emit("ignored");
    await client.flush();
    expect(batches.map((batch) => batch.events.map((event) => event.name))).toEqual([["cleanup"]]);
    expect(client.pending()).toBe(0);
  });

  it("accounts for a failed final batch and stays disposed", async () => {
    const failure = new BrowserTelemetryClientDeliveryError("offline", true, { cause: "network" });
    const client = createBrowserTelemetryClient({
      transport: async () => {
        throw failure;
      },
      flushIntervalMs: 60_000,
    });
    client.emit("retained");
    await expect(client.dispose()).rejects.toBe(failure);
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(1);
    await client.flush();
    expect(client.pending()).toBe(0);
  });

  it("accounts for queue evictions and permanent transport drops", async () => {
    const queue = createBrowserTelemetryClient({
      maxQueueSize: 2,
      flushIntervalMs: 60_000,
      transport: async () => undefined,
    });
    for (let index = 0; index < 100; index += 1) queue.emit(`event.${index}`);
    expect(queue.pending()).toBe(2);
    expect(queue.dropped()).toBe(98);
    await queue.flush();
    expect(queue.pending()).toBe(0);
    expect(queue.dropped()).toBe(98);
    await queue.dispose();

    const permanent = new BrowserTelemetryClientDeliveryError("rejected", false, {
      cause: 400,
    });
    const client = createBrowserTelemetryClient({
      flushIntervalMs: 60_000,
      transport: async () => {
        throw permanent;
      },
    });
    client.emit("permanent");
    await expect(client.flush()).rejects.toBe(permanent);
    expect(client.pending()).toBe(0);
    expect(client.dropped()).toBe(1);
    await client.dispose();
  });

  it("owns periodic delivery until disposal", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const client = createBrowserTelemetryClient({
      transport: async (batch) => {
        batches.push(batch);
      },
      flushIntervalMs: 10,
    });
    client.emit("periodic");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(batches).toHaveLength(1);
    await client.dispose();
    client.emit("after-disposal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches).toHaveLength(1);
  });

  it("is allocation-free at the transport boundary when disabled", async () => {
    let calls = 0;
    const client = createBrowserTelemetryClient({
      disabled: true,
      transport: async () => {
        calls += 1;
      },
    });
    client.emit("ignored");
    expect(client.pending()).toBe(0);
    await client.flush();
    await client.dispose();
    expect(calls).toBe(0);
  });
});
