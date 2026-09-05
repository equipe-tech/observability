import { createServer } from "node:http";
import { Schema } from "effect";
import { assert, describe, it } from "vite-plus/test";
import type { BrowserTelemetryClientBatch } from "@equipe-tech/observability/browser/client";
import * as Root from "@equipe-tech/observability";
import { definePolicy } from "@equipe-tech/observability/policy";
import {
  BrowserObservabilityError,
  createBrowserObservability,
  runBrowserDeliveryCanary,
  type BrowserEventHost,
} from "../src/index.ts";
import * as ReactEntrypoint from "../src/index.ts";

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

const configInvalidMessage =
  "The React browser observability configuration requires canonical identity, a compilable policy, valid positive options, and a usable browser event host.";

const assertConfigCode = (create: () => void, code: BrowserObservabilityError["code"]): void => {
  try {
    create();
    assert.fail(`Expected ${code}`);
  } catch (cause: unknown) {
    assert.instanceOf(cause, BrowserObservabilityError);
    if (cause instanceof BrowserObservabilityError) {
      assert.strictEqual(cause.code, code);
      assert.strictEqual(cause.message, configInvalidMessage);
    }
  }
};

const assertCanaryError = async (
  run: () => Promise<unknown>,
  code: BrowserObservabilityError["code"],
  message: string,
): Promise<void> => {
  try {
    await run();
    assert.fail(`Expected ${code}`);
  } catch (cause: unknown) {
    assert.instanceOf(cause, BrowserObservabilityError);
    if (cause instanceof BrowserObservabilityError) {
      assert.strictEqual(cause.code, code);
      assert.strictEqual(cause.message, message);
    }
  }
};

describe("React browser observability", () => {
  it("keeps the audit API out of the React source entrypoint", () => {
    const auditApiNames = Object.keys(Root).filter((name) => name.toLowerCase().includes("audit"));
    assert.isAbove(auditApiNames.length, 0);
    for (const name of auditApiNames) assert.notProperty(ReactEntrypoint, name);
  });

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
    assert.strictEqual(report.failed, 0);
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

  it("returns a failed outcome instead of policy suppression for an internal failure", async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        randomUUID: () => {
          throw new Error("random unavailable");
        },
      },
    });
    const fixture = recordingHost();
    try {
      const observability = createBrowserObservability({
        service,
        policy,
        host: fixture.host,
        sentry: { disabled: true },
      });
      assert.deepEqual(
        observability.defects.report({ error: new Error("failed"), origin: "manual" }),
        {
          kind: "failed",
          destinations: { sentry: "not-attempted", events: "not-attempted" },
        },
      );
      assert.strictEqual(observability.reports().failed, 1);
      assert.strictEqual(observability.reports().suppressed, 0);
      await observability.dispose();
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
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

  it("sanitizes operational error type with the compiled policy before queue insertion", async () => {
    const batches: Array<BrowserTelemetryClientBatch> = [];
    const fixture = recordingHost();
    const blockedPolicy = definePolicy({
      attributes: {
        "error.origin": { classification: "internal", required: true, metricLabel: false },
      },
      blockedKeys: [],
      blockedValuePatterns: ["secret-[a-z]+"],
    });
    const observability = createBrowserObservability({
      service,
      policy: blockedPolicy,
      host: fixture.host,
      sentry: { disabled: true },
      events: {
        flushIntervalMs: 60_000,
        transport: async (batch) => {
          batches.push(batch);
        },
      },
    });
    const error = new Error("safe");
    error.name = "secret-token";
    observability.defects.report({ error, origin: "manual" });
    await observability.flush();
    assert.strictEqual(batches[0]?.events[0]?.error?.type, "[REDACTED]");
    assert.notInclude(JSON.stringify(batches), "secret-token");
    await observability.dispose();
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

  it("rejects malformed and non-HTTPS production DSNs before reserving the host", async () => {
    const fixture = recordingHost();
    for (const config of [
      { service, policy, host: fixture.host, sentry: { dsn: "not-a-dsn" } },
      {
        service: { ...service, environment: "production" },
        policy,
        host: fixture.host,
        sentry: { dsn: "http://public@telemetry.example.com/1" },
      },
    ]) {
      assertConfigCode(() => createBrowserObservability(config), "OBS_REACT_CONFIG_INVALID");
      assert.isTrue([...fixture.listeners.values()].every((registered) => registered.size === 0));
      const recovery = createBrowserObservability({
        service,
        policy,
        host: fixture.host,
        sentry: { disabled: true },
      });
      await recovery.dispose();
    }
  });

  it("rolls back every partial listener registration and permits immediate recovery", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const activeTimers = new Set<ReturnType<typeof setInterval>>();
    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: (handler: Parameters<typeof setInterval>[0], timeout?: number) => {
        const timer = originalSetInterval(handler, timeout);
        activeTimers.add(timer);
        return timer;
      },
    });
    Object.defineProperty(globalThis, "clearInterval", {
      configurable: true,
      value: (timer: ReturnType<typeof setInterval>) => {
        activeTimers.delete(timer);
        originalClearInterval(timer);
      },
    });
    try {
      for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
        const listeners = new Map<string, Set<(event: Event) => void>>();
        let registrationIndex = 0;
        let failing = true;
        const host: BrowserEventHost = {
          addEventListener: (name, listener) => {
            const current = listeners.get(name) ?? new Set();
            current.add(listener);
            listeners.set(name, current);
            if (failing && registrationIndex === failureIndex) throw new Error("listener failed");
            registrationIndex += 1;
          },
          removeEventListener: (name, listener) => {
            listeners.get(name)?.delete(listener);
          },
        };
        assertConfigCode(
          () =>
            createBrowserObservability({
              service,
              policy,
              host,
              sentry: { disabled: true },
              events: { flushIntervalMs: 60_000 },
            }),
          "OBS_REACT_CONFIG_INVALID",
        );
        assert.strictEqual(activeTimers.size, 0);
        assert.isTrue([...listeners.values()].every((registered) => registered.size === 0));
        failing = false;
        registrationIndex = 0;
        const recovery = createBrowserObservability({
          service,
          policy,
          host,
          sentry: { disabled: true },
        });
        await recovery.dispose();
        assert.strictEqual(activeTimers.size, 0);
        assert.isTrue([...listeners.values()].every((registered) => registered.size === 0));
      }
    } finally {
      Object.defineProperty(globalThis, "setInterval", {
        configurable: true,
        value: originalSetInterval,
      });
      Object.defineProperty(globalThis, "clearInterval", {
        configurable: true,
        value: originalClearInterval,
      });
    }
  });

  it("wraps hostile nested getters and client construction failures without leaking ownership", async () => {
    const fixture = recordingHost();
    for (const nested of ["events", "sentry"]) {
      const events = { flushIntervalMs: 60_000 };
      const sentry = { disabled: true };
      Object.defineProperty(
        nested === "events" ? events : sentry,
        nested === "events" ? "transport" : "dsn",
        {
          get: () => {
            throw new Error("hostile getter");
          },
        },
      );
      assertConfigCode(
        () => createBrowserObservability({ service, policy, host: fixture.host, events, sentry }),
        "OBS_REACT_CONFIG_INVALID",
      );
    }
    const originalSetInterval = globalThis.setInterval;
    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: () => {
        throw new Error("timer construction failed");
      },
    });
    try {
      assertConfigCode(
        () =>
          createBrowserObservability({
            service,
            policy,
            host: fixture.host,
            sentry: { disabled: true },
          }),
        "OBS_REACT_CONFIG_INVALID",
      );
    } finally {
      Object.defineProperty(globalThis, "setInterval", {
        configurable: true,
        value: originalSetInterval,
      });
    }
    const recovery = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { disabled: true },
    });
    await recovery.dispose();
    assert.isTrue([...fixture.listeners.values()].every((registered) => registered.size === 0));
  });

  it("initiates operational and Sentry flush once on pagehide and absorbs rejection", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const fixture = recordingHost();
    let operationalFlushes = 0;
    const observability = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { dsn: `http://public@127.0.0.1:${address.port}/1` },
      events: {
        flushIntervalMs: 60_000,
        transport: async () => {
          operationalFlushes += 1;
          throw new Error("operational flush rejected");
        },
      },
    });
    observability.defects.report({ error: new Error("page hidden"), origin: "manual" });
    fixture.dispatch("pagehide", new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.strictEqual(operationalFlushes, 1);
    assert.strictEqual(observability.reports().sentry.reasons.flushIncomplete, 1);
    assert.strictEqual(observability.reports().failed, 1);
    server.closeAllConnections();
    await observability.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
    );
  });

  it("reconciles recorded, pending, and dropped delivery counts under queue pressure", async () => {
    const fixture = recordingHost();
    const observability = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { disabled: true },
      events: {
        maxQueueSize: 2,
        flushIntervalMs: 60_000,
        transport: async () => undefined,
      },
    });
    for (let index = 0; index < 100; index += 1) {
      observability.defects.report({ error: new Error(`failure-${index}`), origin: "manual" });
    }
    const queued = observability.reports();
    assert.strictEqual(queued.recorded, 100);
    assert.strictEqual(queued.pendingEvents, 2);
    assert.strictEqual(queued.deliveryDropped, 98);
    assert.strictEqual(queued.recorded, queued.pendingEvents + queued.deliveryDropped);
    await observability.flush();
    const delivered = observability.reports();
    assert.strictEqual(delivered.pendingEvents, 0);
    assert.strictEqual(delivered.deliveryDropped, 98);
    await observability.dispose();
  });

  it("requires a Sentry DSN in production even when Sentry is disabled", () => {
    const fixture = recordingHost();
    for (const sentry of [
      { disabled: true },
      { disabled: true, dsn: "https://public@telemetry.example.com/1" },
    ]) {
      assertConfigCode(
        () =>
          createBrowserObservability({
            service: { ...service, environment: "production" },
            policy,
            host: fixture.host,
            sentry,
          }),
        "OBS_REACT_CONFIG_INVALID",
      );
    }
  });

  it("keeps hostile listener and React callback values inside one failure boundary", async () => {
    const fixture = recordingHost();
    const observability = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { disabled: true },
    });
    const throwingEvent = new Event("error");
    Object.defineProperty(throwingEvent, "error", {
      get: () => {
        throw new Error("getter exploded");
      },
    });
    fixture.dispatch("error", throwingEvent);
    const revoked = Proxy.revocable(new Error("revoked"), {});
    revoked.revoke();
    observability.reactRootOptions.onUncaughtError(revoked.proxy, {});
    const info: { readonly componentStack?: string } = {};
    Object.defineProperty(info, "componentStack", {
      get: () => {
        throw new Error("stack getter exploded");
      },
    });
    observability.reactRootOptions.onCaughtError(new Error("render"), info);
    assert.strictEqual(observability.reports().failed, 3);
    assert.strictEqual(observability.reports().recorded, 0);
    await observability.dispose();
  });

  it("bounds flush when transport ignores abort and composes with disposal", async () => {
    const fixture = recordingHost();
    const observability = createBrowserObservability({
      service,
      policy,
      host: fixture.host,
      sentry: { disabled: true },
      events: {
        flushIntervalMs: 60_000,
        transport: async () => new Promise<void>(() => undefined),
      },
    });
    observability.events.emit("flush.hang");
    const startedAt = Date.now();
    const flush = observability.flush();
    assert.strictEqual(observability.flush(), flush);
    const disposal = observability.dispose();
    assert.strictEqual(observability.dispose(), disposal);
    const lifecycle = await disposal;
    assert.isBelow(Date.now() - startedAt, 2_000);
    assert.isTrue(lifecycle.degraded);
    await flush;
    assert.isAtLeast(Date.now() - startedAt, 4_900);
    assert.isAbove(observability.reports().failed, 0);
    await observability[Symbol.asyncDispose]();
  }, 7_000);

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

  it("posts the current empty browser envelope to a real local route", async () => {
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
      assert.strictEqual(body, '{"version":2,"events":[]}');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      );
    }
  });

  it("reports non-202, transport, and frozen five-second timeout failures truthfully", async () => {
    const endpoint = new URL("https://telemetry.example.com/_telemetry/events");
    await assertCanaryError(
      () =>
        runBrowserDeliveryCanary({
          endpoint,
          transport: async () => new Response(null, { status: 503 }),
        }),
      "OBS_REACT_CANARY_FAILED",
      "The browser delivery canary expected HTTP 202 and received 503.",
    );
    await assertCanaryError(
      () =>
        runBrowserDeliveryCanary({
          endpoint,
          transport: async () => Promise.reject(new Error("connection refused")),
        }),
      "OBS_REACT_CANARY_FAILED",
      "The browser delivery canary transport failed before receiving a response.",
    );
    await assertCanaryError(
      () =>
        runBrowserDeliveryCanary({
          endpoint,
          transport: async (_endpoint, signal) =>
            new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        }),
      "OBS_REACT_CANARY_FAILED",
      "The browser delivery canary timed out after five seconds.",
    );
  }, 7_000);

  it("gives each invalid canary configuration branch its exact code and message", async () => {
    await assertCanaryError(
      () =>
        runBrowserDeliveryCanary({
          endpoint: new URL("https://user:secret@telemetry.example.com/_telemetry/events"),
        }),
      "OBS_REACT_CANARY_ENDPOINT_INVALID",
      "The browser delivery canary endpoint must not contain credentials.",
    );
    await assertCanaryError(
      () => runBrowserDeliveryCanary({ endpoint: new URL("http://telemetry.example.com") }),
      "OBS_REACT_CANARY_ENDPOINT_INVALID",
      "The published browser delivery canary endpoint must use HTTPS.",
    );
    await assertCanaryError(
      () => runBrowserDeliveryCanary({ endpoint: new URL("https://127.0.0.1") }),
      "OBS_REACT_CANARY_ENDPOINT_INVALID",
      "The published browser delivery canary endpoint must use a globally routable host.",
    );
    await assertCanaryError(
      () => runBrowserDeliveryCanary({ endpoint: new URL("ftp://localhost"), topology: "local" }),
      "OBS_REACT_CANARY_ENDPOINT_INVALID",
      "The local browser delivery canary endpoint must use HTTP or HTTPS.",
    );
    await assertCanaryError(
      () =>
        runBrowserDeliveryCanary({
          endpoint: new URL("https://telemetry.example.com"),
          topology: "local",
        }),
      "OBS_REACT_CANARY_ENDPOINT_INVALID",
      "The local browser delivery canary endpoint must use a loopback or private host.",
    );
    await assertCanaryError(
      () =>
        runBrowserDeliveryCanary({
          endpoint: new URL("http://localhost"),
          topology: "local",
          transport: async () => new Response(null, { status: 202 }),
        }),
      "OBS_REACT_CONFIG_INVALID",
      "The local browser delivery canary does not allow a custom transport.",
    );
  });

  it("accepts only globally routable published hosts", async () => {
    const invalidHosts = [
      "localhost",
      "localhost.",
      "localhost..",
      "localhost....",
      "app.localhost",
      "app.localhost.",
      "app.localhost...",
      "app.local",
      "app.local.",
      "app.local..",
      "0.0.0.0",
      "0x7f000001",
      "0177.0.0.1",
      "2130706433",
      "127.1",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.2",
      "169.254.0.1",
      "172.16.0.1",
      "192.168.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.31.196.0",
      "192.31.196.255",
      "192.88.99.1",
      "192.175.48.0",
      "192.175.48.255",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "[::]",
      "[0:0:0:0:0:0:0:0]",
      "[::1]",
      "[0:0:0:0:0:0:0:1]",
      "[::ffff:127.0.0.1]",
      "[0:0:0:0:0:ffff:10.0.0.1]",
      "[::ffff:8.8.8.8]",
      "[fc00::1]",
      "[fd00::1]",
      "[fe80::1]",
      "[fe90::1]",
      "[febf::1]",
      "[fec0::1]",
      "[ff02::1]",
      "[2001:2::1]",
      "[2001:db8::1]",
      "[2002::1]",
      "[3fff::1]",
    ];
    for (const host of invalidHosts) {
      const endpoint = new URL(`https://${host}/_telemetry/events`);
      await assertCanaryError(
        () =>
          runBrowserDeliveryCanary({
            endpoint,
            transport: async () => new Response(null, { status: 202 }),
          }),
        "OBS_REACT_CANARY_ENDPOINT_INVALID",
        "The published browser delivery canary endpoint must use a globally routable host.",
      );
    }
    for (const host of [
      "8.8.8.8",
      "1.1.1.1",
      "192.31.195.255",
      "192.31.197.0",
      "192.175.47.255",
      "192.175.49.0",
      "[2000::1]",
      "[2001:4860:4860::8888]",
      "[3fff:ffff::1]",
      "[2606:4700:4700::1111]",
      "telemetry.example.com",
      "telemetry.example.com.",
    ]) {
      const endpoint = new URL(`https://${host}/_telemetry/events`);
      const receipt = await runBrowserDeliveryCanary({
        endpoint,
        transport: async () => new Response(null, { status: 202 }),
      });
      assert.strictEqual(receipt.endpointOrigin, endpoint.origin);
    }
  });
});
