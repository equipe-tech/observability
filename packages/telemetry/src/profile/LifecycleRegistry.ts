import { Clock, Effect, Option, Schema } from "effect";
import type { OtlpExporter } from "effect/unstable/observability";
import {
  AdapterFailure,
  AdapterName,
  OfficialAdapterRegistration,
  type AdapterOutcome,
  type AdapterRegistration,
  type LifecycleReport,
  type StartedAdapter,
} from "./ObservabilityAdapter.ts";
import { InvalidObservabilityConfig } from "./ObservabilityConfigError.ts";
import {
  profileCapabilityRequirement,
  type AdapterCapability,
  type ExternalAdapterCapability,
  type LifecycleStage,
  type ObservabilityProfile,
} from "./ObservabilityProfile.ts";

export class ObservabilityLifecycleError extends Schema.TaggedError<ObservabilityLifecycleError>()(
  "ObservabilityLifecycleError",
  {
    code: Schema.Literals(["OBS_OBSERVABILITY_STARTUP_FAILED", "OBS_OBSERVABILITY_CLOSED"]),
    message: Schema.String,
    adapter: Schema.Option(AdapterName),
    cause: Schema.Defect(),
  },
) {}

const expectedStage = (
  profile: ObservabilityProfile,
  capability: AdapterCapability,
): LifecycleStage =>
  capability === "metrics"
    ? "metrics"
    : capability === "browser-ingest" && profile.runtime === "browser-global"
      ? "browser"
      : "server";

const invalidAdapter = (
  code:
    | "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED"
    | "OBS_OBSERVABILITY_ADAPTER_MISSING"
    | "OBS_OBSERVABILITY_ADAPTER_DUPLICATE",
  message: string,
): InvalidObservabilityConfig =>
  new InvalidObservabilityConfig({
    code,
    field: "adapters",
    message,
    rule: "one supported branded registration for each required external capability",
  });

export const validateAdapterRegistrations = (
  profile: ObservabilityProfile,
  environment: string,
  registrations: ReadonlyArray<AdapterRegistration>,
): Effect.Effect<void, InvalidObservabilityConfig> => {
  const names = new Set<string>();
  const capabilities = new Set<AdapterCapability>();
  for (const registration of registrations) {
    registration.registrationBrand();
    const adapter = registration.adapter;
    if (names.has(adapter.name)) {
      return Effect.fail(
        invalidAdapter(
          "OBS_OBSERVABILITY_ADAPTER_DUPLICATE",
          `Adapter "${adapter.name}" is registered more than once. Use one registration per adapter name.`,
        ),
      );
    }
    names.add(adapter.name);
    const requirement = profileCapabilityRequirement(profile, adapter.capability);
    if (
      requirement === "forbidden" ||
      adapter.stage !== expectedStage(profile, adapter.capability) ||
      !profile.stages.includes(adapter.stage) ||
      adapter.capability === "traces" ||
      adapter.capability === "metrics"
    ) {
      return Effect.fail(
        invalidAdapter(
          "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
          `Adapter "${adapter.name}" cannot supply ${adapter.capability} for profile "${profile.name}".`,
        ),
      );
    }
    capabilities.add(adapter.capability);
  }
  const externalCapabilities: ReadonlyArray<ExternalAdapterCapability> = [
    "events",
    "defects",
    "browser-ingest",
  ];
  for (const capability of externalCapabilities) {
    const requirement = profileCapabilityRequirement(profile, capability);
    const required =
      requirement === "required" ||
      (requirement === "required-in-production" && environment === "production");
    if (required && !capabilities.has(capability)) {
      return Effect.fail(
        invalidAdapter(
          "OBS_OBSERVABILITY_ADAPTER_MISSING",
          `Profile "${profile.name}" requires an official ${capability} adapter in ${environment}.`,
        ),
      );
    }
  }
  return Effect.void;
};

const adapterFailure = (operation: "flush" | "close", cause: unknown): AdapterFailure =>
  cause instanceof AdapterFailure
    ? cause
    : new AdapterFailure({
        code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
        message: `Observability adapter ${operation} failed. Inspect the typed cause and retry only when the adapter permits it.`,
        cause,
      });

const ordered = (
  started: ReadonlyArray<StartedAdapter>,
  stage: LifecycleStage,
): ReadonlyArray<StartedAdapter> => {
  const rank = (capability: AdapterCapability): number => {
    switch (capability) {
      case "browser-ingest":
        return -1;
      case "events":
        return 0;
      case "traces":
        return 1;
      case "defects":
        return 2;
      case "metrics":
        return 3;
    }
  };
  return started
    .filter((entry) => entry.registration.adapter.stage === stage)
    .toSorted(
      (left, right) =>
        rank(left.registration.adapter.capability) - rank(right.registration.adapter.capability),
    );
};

const runParticipant = Effect.fn("runObservabilityParticipant")(function* (
  entry: StartedAdapter,
  operation: "flush" | "close",
  budgetMillis: number,
): Effect.fn.Return<AdapterOutcome, never> {
  const adapter = entry.registration.adapter;
  if (budgetMillis <= 0) {
    return {
      adapter: adapter.name,
      capability: adapter.capability,
      stage: adapter.stage,
      result: { kind: "skipped", reason: "deadline-exhausted" },
    };
  }
  const startedAt = yield* Clock.currentTimeMillis;
  const effect = operation === "flush" ? entry.handle.flush : entry.handle.close;
  const result = yield* effect.pipe(Effect.exit, Effect.timeoutOption(budgetMillis));
  const durationMillis = (yield* Clock.currentTimeMillis) - startedAt;
  if (Option.isNone(result)) {
    return {
      adapter: adapter.name,
      capability: adapter.capability,
      stage: adapter.stage,
      result: { kind: "deadline-exceeded", budgetMillis },
    };
  }
  if (result.value._tag === "Failure") {
    return {
      adapter: adapter.name,
      capability: adapter.capability,
      stage: adapter.stage,
      result: {
        kind: "failed",
        error: adapterFailure(operation, result.value.cause),
      },
    };
  }
  return {
    adapter: adapter.name,
    capability: adapter.capability,
    stage: adapter.stage,
    result: { kind: "completed", durationMillis },
  };
});

const coreRegistration = (
  name: string,
  capability: "traces" | "metrics",
  stage: "server" | "metrics",
  effect: Effect.Effect<void>,
): StartedAdapter => ({
  registration: new OfficialAdapterRegistration({
    name: AdapterName.make(name),
    capability,
    stage,
    start: () => Effect.die("Built-in lifecycle participants are already started."),
  }),
  handle: { flush: effect, close: effect },
});

export type LifecycleRegistry = {
  readonly run: (operation: "flush" | "close") => Effect.Effect<LifecycleReport>;
};

export const createLifecycleRegistry = (
  profile: ObservabilityProfile,
  started: ReadonlyArray<StartedAdapter>,
  flusher: OtlpExporter.Flusher["Service"],
  disposeRuntime: Effect.Effect<void>,
): LifecycleRegistry => {
  const traces = coreRegistration("core-traces", "traces", "server", flusher.flush);
  const metrics = coreRegistration("core-metrics", "metrics", "metrics", flusher.flush);
  const participants = [...started, traces, metrics];
  const run = Effect.fn("LifecycleRegistry.run")(function* (
    operation: "flush" | "close",
  ): Effect.fn.Return<LifecycleReport, never> {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + profile.shutdownDeadlineMillis;
    const outcomes: Array<AdapterOutcome> = [];
    for (const stage of profile.stages) {
      const now = yield* Clock.currentTimeMillis;
      const totalRemaining = Math.max(0, deadline - now);
      const stageBudget = profile.stageDeadlineMillis.get(stage) ?? totalRemaining;
      const stageDeadline = now + Math.min(totalRemaining, stageBudget);
      for (const participant of ordered(participants, stage)) {
        const remaining = Math.max(0, stageDeadline - (yield* Clock.currentTimeMillis));
        outcomes.push(yield* runParticipant(participant, operation, remaining));
      }
    }
    if (operation === "close") {
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      yield* disposeRuntime.pipe(Effect.timeoutOption(remaining), Effect.asVoid);
    }
    const durationMillis = (yield* Clock.currentTimeMillis) - startedAt;
    return {
      operation,
      outcomes,
      durationMillis,
      degraded: outcomes.some((outcome) => outcome.result.kind !== "completed"),
    };
  });
  return { run };
};

export const rollbackStartedAdapters = Effect.fn("rollbackStartedAdapters")(function* (
  started: ReadonlyArray<StartedAdapter>,
): Effect.fn.Return<void, never> {
  for (const entry of started.toReversed()) {
    yield* entry.handle.close.pipe(Effect.catch(() => Effect.void));
  }
});
