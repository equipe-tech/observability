import { describe, expect, it } from "vite-plus/test";
import {
  BrowserTelemetryClientDeliveryError,
  createBrowserTelemetryClient,
  type BrowserTelemetryClientBatch,
  type BrowserTelemetryClientTransport,
} from "../src/browser/index.ts";
import { sensitiveFieldReplacement, sensitiveTextReplacement } from "../src/RedactionPolicy.ts";

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} => {
  let complete = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
};

describe("browser telemetry client", () => {
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
