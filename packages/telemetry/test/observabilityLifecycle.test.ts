import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
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
import { TelemetryEventSink } from "../src/contract/EventProducer.ts";
import {
  createLifecycleRegistry,
  validateAdapterRegistrations,
} from "../src/profile/LifecycleRegistry.ts";
import { workerProfile } from "../src/profile/ObservabilityProfile.ts";
import {
  acquireRuntimeFlusher,
  createNodeObservability,
  createNodeObservabilityFromConfig,
  createTestingNodeObservabilityFromConfig,
  layerNodeObservability,
  makeNodeObservability,
  NodeObservabilityService,
  type NodeObservabilityEnabled,
} from "../src/node/Observability.ts";

const contract: ContractRegistry = {
  version: 1,
  eventNames: [],
  eventByAlias: new Map<string, CompiledEventDefinition>(),
  eventByName: new Map<EventName, CompiledEventDefinition>(),
  auditActionByAlias: new Map<string, CompiledAuditActionDefinition>(),
  auditActionByName: new Map<string, CompiledAuditActionDefinition>(),
  metricByAlias: new Map(),
  metricByName: new Map(),
};
const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };
const testEventLayer = Layer.succeed(
  TelemetryEventSink,
  TelemetryEventSink.of({
    record: () => Effect.void,
    admitBrowserBatch: () => Effect.succeed({ commit: Effect.void }),
  }),
);

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
      eventLayer: Option.some(testEventLayer),
      degraded: () => false,
      flush: Effect.sync(() => {
        calls.push(`flush:${name}`);
      }),
      close: Effect.sync(() => {
        calls.push(`close:${name}`);
      }),
    });
  },
});

const lifecycleOperations: ReadonlyArray<"flush" | "close"> = ["flush", "close"];

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

    const coreClaims: ReadonlyArray<{
      readonly name: string;
      readonly capability: "traces" | "metrics";
      readonly stage: "server" | "metrics";
    }> = [
      { name: "user-traces", capability: "traces", stage: "server" },
      { name: "user-metrics", capability: "metrics", stage: "metrics" },
    ];
    for (const core of coreClaims) {
      const registration = registerTestingAdapter({
        name: AdapterName.make(core.name),
        capability: core.capability,
        stage: core.stage,
        start: () =>
          Effect.succeed({
            flush: Effect.void,
            close: Effect.void,
            eventLayer: Option.none(),
            degraded: () => false,
          }),
      });
      const error = await Effect.runPromise(
        Effect.flip(
          validateAdapterRegistrations(parsed.profile, "test", [registration], {
            allowTesting: true,
          }),
        ),
      );
      expect(error).toMatchObject({
        code: "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
        field: "adapters",
      });
    }

    const coreReport = await Effect.runPromise(
      createLifecycleRegistry(
        workerProfile,
        [],
        OtlpExporter.Flusher.of({ flush: Effect.void, register: () => Effect.void }),
        Effect.void,
      ).run("flush"),
    );
    expect(
      coreReport.outcomes.flatMap((outcome) =>
        outcome.participant === "adapter" ? [[String(outcome.adapter), outcome.capability]] : [],
      ),
    ).toEqual([
      ["core-traces", "traces"],
      ["core-metrics", "metrics"],
    ]);

    for (const reservedName of ["core-traces", "core-metrics"]) {
      const reserved = registerTestingAdapter(recordingAdapter(reservedName, "events", calls));
      const reservedError = await Effect.runPromise(
        Effect.flip(
          validateAdapterRegistrations(parsed.profile, "test", [reserved], {
            allowTesting: true,
          }),
        ),
      );
      expect(reservedError).toMatchObject({
        code: "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
        field: "adapters",
      });
      expect(reservedError.message).toContain("reserved");
    }

    const events = registerTestingAdapter(recordingAdapter("events", "events", calls));
    const duplicate = await Effect.runPromise(
      Effect.flip(
        validateAdapterRegistrations(parsed.profile, "test", [events, events], {
          allowTesting: true,
        }),
      ),
    );
    expect(duplicate.code).toBe("OBS_OBSERVABILITY_ADAPTER_DUPLICATE");

    const differentlyNamedDuplicate = registerTestingAdapter(
      recordingAdapter("other-events", "events", calls),
    );
    const capabilityDuplicate = await Effect.runPromise(
      Effect.flip(
        validateAdapterRegistrations(parsed.profile, "test", [events, differentlyNamedDuplicate], {
          allowTesting: true,
        }),
      ),
    );
    expect(capabilityDuplicate.code).toBe("OBS_OBSERVABILITY_ADAPTER_DUPLICATE");
    expect(capabilityDuplicate.message).toContain('Capability "events"');
  });

  it("runs the public create and Effect entrypoints", async () => {
    const calls: Array<string> = [];
    const registration = registerOfficialAdapter(recordingAdapter("events", "events", calls));
    const parsed = await Effect.runPromise(config());
    const made = enabled(await Effect.runPromise(makeNodeObservability(parsed, [registration])));
    await made.close();
    const created = enabled(
      await createNodeObservability({
        profile: "worker",
        env: { OTEL_SERVICE_NAME: "worker" },
        contract,
        policy,
        adapters: [registration],
      }),
    );
    await created.close();
    expect(calls.filter((call) => call === "start:events")).toHaveLength(2);
    expect(calls.filter((call) => call === "close:events")).toHaveLength(2);
  });

  it("runs the layer finalizer exactly once", async () => {
    const calls: Array<string> = [];
    const registration = registerOfficialAdapter(recordingAdapter("events", "events", calls));
    await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* NodeObservabilityService;
        expect(handle.enabled).toBe(true);
      }).pipe(
        Effect.provide(
          layerNodeObservability({
            profile: "worker",
            env: { OTEL_SERVICE_NAME: "worker" },
            contract,
            policy,
            adapters: [registration],
          }),
        ),
        Effect.scoped,
      ),
    );
    expect(calls.filter((call) => call === "close:events")).toHaveLength(1);
  });

  it("disposes the runtime when flusher acquisition fails", async () => {
    let disposed = false;
    const runtime = ManagedRuntime.make(
      Layer.effect(
        OtlpExporter.Flusher,
        Effect.acquireRelease(
          Effect.succeed(
            OtlpExporter.Flusher.of({ flush: Effect.void, register: () => Effect.void }),
          ),
          () =>
            Effect.sync(() => {
              disposed = true;
            }),
        ),
      ).pipe(Layer.tap(() => Effect.die("flusher acquisition failed"))),
    );
    const error = await Effect.runPromise(Effect.flip(acquireRuntimeFlusher(runtime)));
    expect(error).toMatchObject({
      code: "OBS_OBSERVABILITY_STARTUP_FAILED",
      adapter: { _tag: "None" },
    });
    expect(disposed).toBe(true);
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

  it("rejects reserved adapter names when observability is disabled", async () => {
    for (const reservedName of ["core-traces", "core-metrics"]) {
      const registration = registerOfficialAdapter(recordingAdapter(reservedName, "events", []));
      await expect(
        createNodeObservabilityFromConfig({ enabled: false }, [registration]),
      ).rejects.toMatchObject({
        code: "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
        message: expect.stringContaining("reserved"),
      });
    }
  });

  it("matches enabled post-close flush behavior for disabled handles", async () => {
    const handle = await createNodeObservabilityFromConfig({ enabled: false }, []);
    expect((await handle.flush()).operation).toBe("flush");
    const first = handle.close();
    expect(handle.dispose()).toBe(first);
    await first;
    await handle[Symbol.asyncDispose]();
    await expect(handle.flush()).rejects.toMatchObject({
      _tag: "ObservabilityLifecycleError",
      code: "OBS_OBSERVABILITY_CLOSED",
      cause: "flush after close",
    });
  });

  it("uses a changed profile capability order for startup and shutdown", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    if (!parsed.enabled) throw new Error("Expected enabled config.");
    const capabilityOrder: typeof parsed.profile.capabilityOrder = [
      ["server", ["defects", "traces", "events"]],
      ["metrics", ["metrics"]],
    ];
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
    await expect(handle.flush()).rejects.toMatchObject({
      _tag: "ObservabilityLifecycleError",
      code: "OBS_OBSERVABILITY_CLOSED",
      message: "Observability is closed. Create a new runtime before flushing again.",
      adapter: { _tag: "None" },
      cause: "flush after close",
    });
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

  it("waits for an in-flight flush before close starts", async () => {
    const calls: Array<string> = [];
    let releaseFlush: (() => void) | undefined;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const parsed = await Effect.runPromise(config());
    const registration = registerTestingAdapter({
      name: AdapterName.make("events"),
      capability: "events",
      stage: "server",
      start: () =>
        Effect.succeed({
          eventLayer: Option.some(testEventLayer),
          degraded: () => false,
          flush: Effect.promise(() => {
            calls.push("flush:events");
            return flushGate;
          }),
          close: Effect.sync(() => {
            calls.push("close:events");
          }),
        }),
    });
    const handle = enabled(await createTestingNodeObservabilityFromConfig(parsed, [registration]));
    const flushing = handle.flush();
    await Promise.resolve();
    const closing = handle.close();
    await Promise.resolve();
    expect(calls).toEqual(["flush:events"]);
    if (releaseFlush === undefined) throw new Error("Expected the flush gate to be installed.");
    releaseFlush();
    const [flushReport, closeReport] = await Promise.all([flushing, closing]);
    expect(flushReport.operation).toBe("flush");
    expect(closeReport.operation).toBe("close");
    expect(calls).toEqual(["flush:events", "close:events"]);
  });

  for (const operation of lifecycleOperations) {
    it(`preserves the adapter failure for ${operation}`, async () => {
      const failure = new AdapterFailure({
        code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
        message: `events ${operation} failed`,
        cause: `${operation} transport`,
      });
      const registration = registerTestingAdapter(recordingAdapter("events", "events", []));
      const started: StartedAdapter = {
        registration,
        handle: {
          flush: operation === "flush" ? Effect.fail(failure) : Effect.void,
          close: operation === "close" ? Effect.fail(failure) : Effect.void,
          eventLayer: Option.none(),
          degraded: () => false,
        },
      };
      const flusher = OtlpExporter.Flusher.of({
        flush: Effect.void,
        register: () => Effect.void,
      });
      const report = await Effect.runPromise(
        createLifecycleRegistry(workerProfile, [started], flusher, Effect.void).run(operation),
      );
      expect(report.outcomes[0]).toEqual({
        participant: "adapter",
        adapter: AdapterName.make("events"),
        capability: "events",
        stage: "server",
        result: { kind: "failed", error: failure },
      });
      expect(
        report.outcomes[0]?.result.kind === "failed" ? report.outcomes[0].result.error : undefined,
      ).toBe(failure);
    });
  }

  it("caps metrics at three seconds inside the five-second absolute deadline", async () => {
    const calls: Array<string> = [];
    const registration = registerTestingAdapter(recordingAdapter("events", "events", calls));
    const started: StartedAdapter = {
      registration,
      handle: {
        flush: Effect.void,
        close: Effect.void,
        eventLayer: Option.none(),
        degraded: () => false,
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
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1450 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(report.durationMillis).toBe(3_500);
    expect(
      report.outcomes.find(
        (outcome) => outcome.participant === "adapter" && outcome.adapter === "core-metrics",
      )?.result,
    ).toEqual({
      kind: "deadline-exceeded",
      budgetMillis: 3_000,
      forcedCleanup: { kind: "deadline-exceeded", budgetMillis: 500 },
    });
  });

  it("gives a timed-out close one bounded forced retry before runtime disposal", async () => {
    const calls: Array<string> = [];
    const events = registerTestingAdapter(recordingAdapter("events", "events", calls));
    const defects = registerTestingAdapter(recordingAdapter("defects", "defects", calls));
    const hangingClose = Effect.gen(function* () {
      calls.push("close:events");
      return yield* Effect.never;
    });
    const started: ReadonlyArray<StartedAdapter> = [
      {
        registration: events,
        handle: {
          flush: Effect.void,
          close: hangingClose,
          eventLayer: Option.none(),
          degraded: () => false,
        },
      },
      {
        registration: defects,
        handle: {
          flush: Effect.void,
          close: Effect.sync(() => {
            calls.push("close:defects");
          }),
          eventLayer: Option.none(),
          degraded: () => false,
        },
      },
    ];
    const flusher = OtlpExporter.Flusher.of({
      flush: Effect.void,
      register: () => Effect.void,
    });
    const registry = createLifecycleRegistry(workerProfile, started, flusher, Effect.void);
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(registry.run("close"));
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(report.degraded).toBe(true);
    expect(report.outcomes).toEqual([
      {
        participant: "adapter",
        adapter: AdapterName.make("events"),
        capability: "events",
        stage: "server",
        result: {
          kind: "deadline-exceeded",
          budgetMillis: 3_950,
          forcedCleanup: { kind: "deadline-exceeded", budgetMillis: 500 },
        },
      },
      {
        participant: "adapter",
        adapter: AdapterName.make("core-traces"),
        capability: "traces",
        stage: "server",
        result: {
          kind: "deadline-exceeded",
          budgetMillis: 0,
          forcedCleanup: { kind: "completed", durationMillis: 0 },
        },
      },
      {
        participant: "adapter",
        adapter: AdapterName.make("defects"),
        capability: "defects",
        stage: "server",
        result: {
          kind: "deadline-exceeded",
          budgetMillis: 0,
          forcedCleanup: { kind: "completed", durationMillis: 0 },
        },
      },
      {
        participant: "adapter",
        adapter: AdapterName.make("core-metrics"),
        capability: "metrics",
        stage: "metrics",
        result: {
          kind: "deadline-exceeded",
          budgetMillis: 0,
          forcedCleanup: { kind: "completed", durationMillis: 0 },
        },
      },
      {
        participant: "runtime-disposal",
        result: { kind: "completed", durationMillis: 0 },
      },
    ]);
    expect(calls).toEqual(["close:events", "close:events", "close:defects"]);
    expect(report.durationMillis).toBeLessThanOrEqual(5_000);
  });

  it("rolls back startup when the events adapter omits its service layer", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config());
    const events = registerTestingAdapter({
      name: AdapterName.make("events"),
      capability: "events",
      stage: "server",
      start: () =>
        Effect.succeed({
          eventLayer: Option.none(),
          degraded: () => false,
          flush: Effect.void,
          close: Effect.sync(() => {
            calls.push("close:events");
          }),
        }),
    });
    await expect(createTestingNodeObservabilityFromConfig(parsed, [events])).rejects.toMatchObject({
      code: "OBS_OBSERVABILITY_STARTUP_FAILED",
      adapter: { value: AdapterName.make("events") },
      cause: "missing events service layer",
    });
    expect(calls).toEqual(["close:events"]);
  });

  it("rolls back started adapters in exact reverse order", async () => {
    const calls: Array<string> = [];
    const parsed = await Effect.runPromise(config("production"));
    await expect(
      createTestingNodeObservabilityFromConfig(parsed, [
        registerTestingAdapter(recordingAdapter("events", "events", calls)),
        registerTestingAdapter(recordingAdapter("defects", "defects", calls, true)),
      ]),
    ).rejects.toMatchObject({
      _tag: "ObservabilityLifecycleError",
      code: "OBS_OBSERVABILITY_STARTUP_FAILED",
      adapter: { value: AdapterName.make("defects") },
      cause: {
        _tag: "AdapterFailure",
        code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
        message: "defects failed",
        cause: "defects",
      },
    });
    expect(calls).toEqual(["start:events", "start:defects", "close:events"]);
  });
});
