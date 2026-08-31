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
import { definePolicy } from "../src/policy/DataPolicy.ts";
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
    const client = createBrowserTelemetryClient({
      policy,
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
    expect(client.pending()).toBe(1);
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
    expect(client.pending()).toBe(1);
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

  it("keeps a failed final batch sanitized and stays disposed", async () => {
    const failure = new BrowserTelemetryClientDeliveryError("offline", true, { cause: "network" });
    const client = createBrowserTelemetryClient({
      transport: async () => {
        throw failure;
      },
      flushIntervalMs: 60_000,
    });
    client.emit("retained");
    await expect(client.dispose()).rejects.toBe(failure);
    expect(client.pending()).toBe(1);
    await client.flush();
    expect(client.pending()).toBe(1);
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
