import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { OtlpExporter } from "effect/unstable/observability";
import { describe, expect, it } from "vite-plus/test";
import type { EventName } from "../src/contract/EventName.ts";
import type {
  CompiledAuditActionDefinition,
  CompiledEventDefinition,
} from "../src/contract/TelemetryContract.ts";
import {
  AdapterFailure,
  AdapterName,
  registerOfficialAdapter,
  registerTestingAdapter,
  type ContractRegistry,
  type ObservabilityAdapter,
  type StartedAdapter,
} from "../src/profile/ObservabilityAdapter.ts";
import { parseNodeObservabilityConfig } from "../src/profile/ObservabilityConfig.ts";
import {
  createLifecycleRegistry,
  validateAdapterRegistrations,
} from "../src/profile/LifecycleRegistry.ts";
import { workerProfile } from "../src/profile/ObservabilityProfile.ts";
import {
  createNodeObservabilityFromConfig,
  createTestingNodeObservabilityFromConfig,
  type NodeObservabilityEnabled,
} from "../src/node/Observability.ts";

const contract: ContractRegistry = {
  version: 1,
  eventNames: [],
  eventByAlias: new Map<string, CompiledEventDefinition>(),
  eventByName: new Map<EventName, CompiledEventDefinition>(),
  auditActionByAlias: new Map<string, CompiledAuditActionDefinition>(),
  auditActionByName: new Map<string, CompiledAuditActionDefinition>(),
};
const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };

const config = (environment = "test") =>
  parseNodeObservabilityConfig({
    enabled: true,
    profile: "worker",
    service: { name: "worker", version: "1.4.0", environment },
    telemetry: { endpoint: new URL("http://127.0.0.1:4318") },
    evlog: { contract, policy },
    sentry:
      environment === "production"
        ? { enabled: true, dsn: new URL("https://public@sentry.example/1") }
        : { enabled: false },
  });

const recordingAdapter = (
  name: string,
  capability: "events" | "defects" | "browser-ingest",
  calls: Array<string>,
  startFailure = false,
): ObservabilityAdapter => ({
  name: AdapterName.make(name),
  capability,
  stage: capability === "browser-ingest" ? "browser" : "server",
  start: () => {
    calls.push(`start:${name}`);
    if (startFailure) {
      return Effect.fail(
        new AdapterFailure({
          code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
          message: `${name} failed`,
          cause: name,
        }),
      );
    }
    return Effect.succeed({
      flush: Effect.sync(() => {
        calls.push(`flush:${name}`);
      }),
      close: Effect.sync(() => {
        calls.push(`close:${name}`);
      }),
    });
  },
});

const enabled = (handle: Awaited<ReturnType<typeof createNodeObservabilityFromConfig>>) => {
  expect(handle.enabled).toBe(true);
  if (!handle.enabled) {
    throw new Error("Expected an enabled Node observability handle.");
  }
  return handle satisfies NodeObservabilityEnabled;
};

describe("observability lifecycle", () => {
  it("applies missing, unsupported, and duplicate checks only to external slots", async () => {
    const parsed = await Effect.runPromise(config());
    if (!parsed.enabled) throw new Error("Expected enabled config.");
    const missing = await Effect.runPromise(
      Effect.flip(
        validateAdapterRegistrations(parsed.profile, "test", [], { allowTesting: false }),
      ),
    );
    expect(missing.code).toBe("OBS_OBSERVABILITY_ADAPTER_MISSING");

    const calls: Array<string> = [];
    const unsupported = registerTestingAdapter(
      recordingAdapter("browser", "browser-ingest", calls),
    );
    const unsupportedError = await Effect.runPromise(
      Effect.flip(
        validateAdapterRegistrations(parsed.profile, "test", [unsupported], { allowTesting: true }),
      ),
    );
    expect(unsupportedError.code).toBe("OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED");

    const events = registerTestingAdapter(recordingAdapter("events", "events", calls));
    const duplicate = await Effect.runPromise(
      Effect.flip(
        validateAdapterRegistrations(parsed.profile, "test", [events, events], {
          allowTesting: true,
        }),
      ),
    );
    expect(duplicate.code).toBe("OBS_OBSERVABILITY_ADAPTER_DUPLICATE");
  });

  it("validates official registrations and runs their lifecycle through the root factory", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    const events = registerOfficialAdapter(recordingAdapter("official-events", "events", calls));
    const handle = enabled(await createNodeObservabilityFromConfig(parsed, [events]));
    expect(events.kind).toBe("official");
    expect(calls).toEqual(["start:official-events"]);
    const report = await handle.close();
    expect(report.degraded).toBe(false);
    expect(calls).toContain("close:official-events");
    expect(report.outcomes.at(-1)).toMatchObject({
      participant: "runtime-disposal",
      result: { kind: "completed" },
    });
  });

  it("rejects testing registrations through the root factory with a typed error", async () => {
    const parsed = await Effect.runPromise(config());
    const registration = registerTestingAdapter(recordingAdapter("events", "events", []));
    if (!parsed.enabled) throw new Error("Expected enabled config.");
    await expect(createNodeObservabilityFromConfig(parsed, [registration])).rejects.toMatchObject({
      _tag: "InvalidObservabilityConfig",
      code: "OBS_OBSERVABILITY_ADAPTER_TESTING",
    });
  });

  it("rejects testing registrations even when the root factory is disabled", async () => {
    const registration = registerTestingAdapter(recordingAdapter("events", "events", []));
    await expect(
      createNodeObservabilityFromConfig({ enabled: false }, [registration]),
    ).rejects.toMatchObject({ code: "OBS_OBSERVABILITY_ADAPTER_TESTING" });
  });

  it("uses a changed profile capability order for startup and shutdown", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    if (!parsed.enabled) throw new Error("Expected enabled config.");
    const capabilityOrder = new Map(parsed.profile.capabilityOrder);
    capabilityOrder.set("server", ["defects", "traces", "events"]);
    const reordered = {
      ...parsed,
      profile: { ...parsed.profile, capabilityOrder },
    };
    const handle = enabled(
      await createNodeObservabilityFromConfig(reordered, [
        registerOfficialAdapter(recordingAdapter("events", "events", calls)),
        registerOfficialAdapter(recordingAdapter("defects", "defects", calls)),
      ]),
    );
    expect(calls.slice(0, 2)).toEqual(["start:defects", "start:events"]);
    const report = await handle.close();
    expect(
      report.outcomes.flatMap((outcome) =>
        outcome.participant === "adapter" ? [outcome.adapter] : [],
      ),
    ).toEqual(["defects", "core-traces", "events", "core-metrics"]);
  });

  it("starts adapters in profile order and closes in the same profile order", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    const handle = enabled(
      await createTestingNodeObservabilityFromConfig(parsed, [
        registerTestingAdapter(recordingAdapter("defects", "defects", calls)),
        registerTestingAdapter(recordingAdapter("events", "events", calls)),
      ]),
    );
    expect(calls.slice(0, 2)).toEqual(["start:events", "start:defects"]);
    const report = await handle.close();
    expect(
      report.outcomes.map((outcome) =>
        outcome.participant === "adapter" ? String(outcome.adapter) : outcome.participant,
      ),
    ).toEqual(["events", "core-traces", "defects", "core-metrics", "runtime-disposal"]);
    expect(calls.filter((call) => call.startsWith("close:"))).toEqual([
      "close:events",
      "close:defects",
    ]);
    expect(report.durationMillis).toBeLessThanOrEqual(5_000);
  });

  it("shares one concurrent close and the final report instance", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    const handle = enabled(
      await createTestingNodeObservabilityFromConfig(parsed, [
        registerTestingAdapter(recordingAdapter("events", "events", calls)),
      ]),
    );
    const first = handle.close();
    const second = handle.close();
    expect(first).toBe(second);
    const [firstReport, secondReport] = await Promise.all([first, second]);
    expect(firstReport).toBe(secondReport);
    await handle.dispose();
    await handle[Symbol.asyncDispose]();
    expect(calls.filter((call) => call === "close:events")).toHaveLength(1);
    await expect(handle.flush()).rejects.toBeDefined();
  });

  it("shares concurrent flush operations but permits a later flush", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    const handle = enabled(
      await createTestingNodeObservabilityFromConfig(parsed, [
        registerTestingAdapter(recordingAdapter("events", "events", calls)),
      ]),
    );
    const first = handle.flush();
    const second = handle.flush();
    expect(first).toBe(second);
    expect((await first).operation).toBe("flush");
    expect((await handle.flush()).operation).toBe("flush");
    expect(calls.filter((call) => call === "flush:events")).toHaveLength(2);
    await handle.close();
  });

  it("caps metrics at three seconds inside the five-second absolute deadline", async () => {
    const calls: Array<string> = [];
    const registration = registerTestingAdapter(recordingAdapter("events", "events", calls));
    const started: StartedAdapter = {
      registration,
      handle: {
        flush: Effect.void,
        close: Effect.void,
      },
    };
    let flushCalls = 0;
    const flusher = OtlpExporter.Flusher.of({
      flush: Effect.suspend(() => {
        flushCalls += 1;
        return flushCalls === 1 ? Effect.void : Effect.never;
      }),
      register: () => Effect.void,
    });
    const registry = createLifecycleRegistry(workerProfile, [started], flusher, Effect.void);
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(registry.run("close"));
        yield* TestClock.adjust("3 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(report.durationMillis).toBe(3_000);
    expect(
      report.outcomes.find(
        (outcome) => outcome.participant === "adapter" && outcome.adapter === "core-metrics",
      )?.result,
    ).toEqual({ kind: "deadline-exceeded", budgetMillis: 3_000 });
  });

  it("reports deadline-exceeded disposal when the absolute budget is exhausted", async () => {
    const registration = registerTestingAdapter(recordingAdapter("events", "events", []));
    const started: StartedAdapter = {
      registration,
      handle: { flush: Effect.void, close: Effect.never },
    };
    const flusher = OtlpExporter.Flusher.of({
      flush: Effect.void,
      register: () => Effect.void,
    });
    const registry = createLifecycleRegistry(workerProfile, [started], flusher, Effect.void);
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(registry.run("close"));
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(report.degraded).toBe(true);
    expect(report.outcomes.at(-1)).toEqual({
      participant: "runtime-disposal",
      result: { kind: "deadline-exceeded", budgetMillis: 0 },
    });
  });

  it("rolls back started adapters in exact reverse order", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config("production"));
    await expect(
      createTestingNodeObservabilityFromConfig(parsed, [
        registerTestingAdapter(recordingAdapter("events", "events", calls)),
        registerTestingAdapter(recordingAdapter("defects", "defects", calls, true)),
      ]),
    ).rejects.toBeDefined();
    expect(calls).toEqual(["start:events", "start:defects", "close:events"]);
  });
});
