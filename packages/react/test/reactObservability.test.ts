import { createServer } from "node:http";
import { Schema } from "effect";
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
  const dispatch = (name: string, event: Event): void => {
    for (const listener of listeners.get(name) ?? []) listener(event);
  };
  return { host, listeners, dispatch };
};

const service = { name: "browser-app", version: "0.3.0", environment: "test" };

const assertConfigCode = (create: () => void, code: BrowserObservabilityError["code"]): void => {
  try {
    create();
    assert.fail(`Expected ${code}`);
  } catch (cause: unknown) {
    assert.instanceOf(cause, BrowserObservabilityError);
    if (cause instanceof BrowserObservabilityError) assert.strictEqual(cause.code, code);
  }
};

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

  it("covers inert, closed, callbacks, global events, fingerprint dedupe, reports, and async disposal", async () => {
    const inert = createBrowserObservability({ service, policy, sentry: { disabled: true } });
    if (!inert.installed) {
      assert.deepEqual(inert.defects.report({ error: new Error("inert"), origin: "manual" }), {
        kind: "suppressed",
        reason: "not-installed",
      });
    }
    await inert[Symbol.asyncDispose]();

    const batches: Array<BrowserTelemetryClientBatch> = [];
    const fixture = recordingHost();
    const observability = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { disabled: true, componentStack: true },
      dedupeWindowMillis: 100,
      dedupeCapacity: 2,
      events: {
        flushIntervalMs: 60_000,
        transport: async (batch) => {
          batches.push(batch);
        },
      },
    });
    observability.reactRootOptions.onCaughtError("caught", {
      componentStack: "x".repeat(5_000),
    });
    observability.reactRootOptions.onRecoverableError(new Error("recoverable"), {});
    fixture.dispatch("error", new Event("error"));
    fixture.dispatch("unhandledrejection", new Event("unhandledrejection"));
    fixture.dispatch("pagehide", new Event("pagehide"));
    const first = observability.defects.report({ error: new Error("same"), origin: "manual" });
    const duplicate = observability.defects.report({ error: new Error("same"), origin: "manual" });
    assert.strictEqual(first.kind, "recorded");
    assert.deepEqual(duplicate, { kind: "deduplicated", reason: "fingerprint" });
    await observability.flush();
    const report = observability.reports();
    assert.isAbove(report.recorded, 0);
    assert.strictEqual(report.deduplicated, 1);
    assert.strictEqual(report.pendingEvents, 0);
    const lifecycle = await observability.dispose();
    assert.isAtLeast(lifecycle.durationMillis, 0);
    assert.isFalse(lifecycle.degraded);
    assert.deepEqual(
      observability.defects.report({ error: new Error("closed"), origin: "manual" }),
      {
        kind: "suppressed",
        reason: "closed",
      },
    );
    await observability[Symbol.asyncDispose]();
    assert.isAbove(batches.length, 0);
  });

  it("records operational delivery when Sentry event ID generation fails", async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
    });
    const fixture = recordingHost();
    try {
      const observability = createBrowserObservability({
        service,
        policy,
        host: fixture.host,
        sentry: { dsn: "http://public@127.0.0.1:1/1" },
        events: { flushIntervalMs: 60_000, transport: async () => undefined },
      });
      const outcome = observability.defects.report({
        error: new Error("failed"),
        origin: "manual",
      });
      assert.strictEqual(outcome.kind, "recorded");
      if (outcome.kind === "recorded") assert.strictEqual(outcome.destinations.sentry, "failed");
      await observability.dispose();
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });

  it("suppresses a component stack rejected by policy", async () => {
    const fixture = recordingHost();
    const rejectingPolicy = definePolicy({
      attributes: {
        "error.origin": { classification: "internal", required: true, metricLabel: false },
        "react.component_stack": {
          classification: "forbidden",
          required: false,
          metricLabel: false,
        },
      },
      blockedKeys: [],
      blockedValuePatterns: [],
    });
    const observability = createBrowserObservability({
      service,
      policy: rejectingPolicy,
      host: fixture.host,
      sentry: { disabled: true, componentStack: true },
    });
    assert.deepEqual(
      observability.defects.report({
        error: new Error("policy"),
        origin: "react.uncaught",
        componentStack: "secret",
      }),
      { kind: "suppressed", reason: "policy" },
    );
    await observability.dispose();
  });

  it("maps invalid identity, policy, options, and production defects to config invalid", () => {
    const fixture = recordingHost();
    assertConfigCode(
      () =>
        createBrowserObservability({
          service: { ...service, name: "" },
          policy,
          host: fixture.host,
        }),
      "OBS_REACT_CONFIG_INVALID",
    );
    assertConfigCode(
      () =>
        createBrowserObservability({
          service,
          policy: { ...policy, blockedValuePatterns: ["["] },
          host: fixture.host,
        }),
      "OBS_REACT_CONFIG_INVALID",
    );
    assertConfigCode(
      () =>
        createBrowserObservability({
          service,
          policy,
          host: fixture.host,
          dedupeCapacity: 0,
        }),
      "OBS_REACT_CONFIG_INVALID",
    );
    assertConfigCode(
      () =>
        createBrowserObservability({
          service: { ...service, environment: "production" },
          policy,
          host: fixture.host,
        }),
      "OBS_REACT_CONFIG_INVALID",
    );
    Object.defineProperty(fixture.host, "addEventListener", { value: 0 });
    assertConfigCode(
      () => createBrowserObservability({ service, policy, host: fixture.host }),
      "OBS_REACT_CONFIG_INVALID",
    );
  });

  it("permits an explicit production defects opt-out", async () => {
    const fixture = recordingHost();
    const observability = createBrowserObservability({
      service: { ...service, environment: "production" },
      policy,
      host: fixture.host,
      sentry: { disabled: true, allowDisabledInProduction: true },
    });
    await observability.dispose();
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

  it("posts the exact empty v1 batch to a real local route", async () => {
    let body = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (part) => {
        body += part;
      });
      request.on("end", () => {
        response.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
      server.address(),
    );
    try {
      const receipt = await runBrowserDeliveryCanary({
        endpoint: new URL(`http://127.0.0.1:${address.port}/_telemetry/events`),
        topology: "local",
      });
      assert.strictEqual(receipt.status, 202);
      assert.strictEqual(body, '{"version":1,"events":[]}');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      );
    }
  });

  it("reports remote non-202 and timeout failures with the typed code", async () => {
    for (const transport of [
      async () => new Response(null, { status: 503 }),
      async () => Promise.reject(new Error("timeout")),
    ]) {
      try {
        await runBrowserDeliveryCanary({
          endpoint: new URL("https://telemetry.example.com/_telemetry/events"),
          transport,
        });
        assert.fail("Expected the remote canary to fail");
      } catch (cause: unknown) {
        assert.instanceOf(cause, BrowserObservabilityError);
        if (cause instanceof BrowserObservabilityError) {
          assert.strictEqual(cause.code, "OBS_REACT_CANARY_FAILED");
        }
      }
    }
  });

  it("classifies credentials, protocols, loopback, private IPs, IPv6, and local names", async () => {
    for (const endpoint of [
      new URL("http://telemetry.example.com/_telemetry/events"),
      new URL("https://user:secret@telemetry.example.com/_telemetry/events"),
      new URL("https://localhost/_telemetry/events"),
      new URL("https://app.localhost/_telemetry/events"),
      new URL("https://app.local/_telemetry/events"),
      new URL("https://127.0.0.2/_telemetry/events"),
      new URL("https://10.0.0.1/_telemetry/events"),
      new URL("https://172.16.0.1/_telemetry/events"),
      new URL("https://192.168.0.1/_telemetry/events"),
      new URL("https://169.254.0.1/_telemetry/events"),
      new URL("https://[::1]/_telemetry/events"),
      new URL("https://[fc00::1]/_telemetry/events"),
      new URL("https://[fd00::1]/_telemetry/events"),
      new URL("https://[fe80::1]/_telemetry/events"),
      new URL("/_telemetry/events", "http://localhost"),
    ]) {
      try {
        await runBrowserDeliveryCanary({ endpoint });
        assert.fail(`Expected ${endpoint.href} to fail`);
      } catch (cause: unknown) {
        assert.instanceOf(cause, BrowserObservabilityError);
        if (cause instanceof BrowserObservabilityError) {
          assert.strictEqual(cause.code, "OBS_REACT_CANARY_ENDPOINT_INVALID");
        }
      }
    }
    const receipt = await runBrowserDeliveryCanary({
      endpoint: new URL("https://telemetry.example.com/_telemetry/events"),
      transport: async () => new Response(null, { status: 202 }),
    });
    assert.strictEqual(receipt.endpointOrigin, "https://telemetry.example.com");
  });
});
