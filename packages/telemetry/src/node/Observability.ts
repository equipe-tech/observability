import { Cause, Context, Duration, Effect, Layer, ManagedRuntime, Option } from "effect";
import { OtlpExporter } from "effect/unstable/observability";
import { TelemetryEventSink } from "../contract/EventProducer.ts";
import * as Telemetry from "../Telemetry.ts";
import {
  nodeObservabilityConfigFromEnv,
  type EnvBootstrapInput,
  type NodeObservabilityConfig,
  type NodeObservabilityConfigEnabled,
} from "../profile/ObservabilityConfig.ts";
import type {
  AdapterRegistration,
  LifecycleReport,
  StartedAdapter,
  TestingAdapterRegistration,
} from "../profile/ObservabilityAdapter.ts";
import {
  createLifecycleRegistry,
  ObservabilityLifecycleError,
  rollbackStartedAdapters,
  validateAdapterRegistrationKinds,
  validateAdapterRegistrations,
} from "../profile/LifecycleRegistry.ts";
import type { DuplicateReleaseVariable } from "../profile/ObservabilityConfigError.ts";
import { InvalidObservabilityConfig } from "../profile/ObservabilityConfigError.ts";
import { profileCapabilityRank } from "../profile/ObservabilityProfile.ts";

export type NodeObservabilityDisabled = {
  readonly enabled: false;
  readonly eventLayer: Layer.Layer<TelemetryEventSink>;
  readonly flush: () => Promise<LifecycleReport>;
  readonly close: () => Promise<LifecycleReport>;
  readonly dispose: () => Promise<LifecycleReport>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
};

export type NodeObservabilityEnabled = {
  readonly enabled: true;
  readonly config: NodeObservabilityConfigEnabled;
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, InvalidObservabilityConfig>;
  readonly eventLayer: Layer.Layer<TelemetryEventSink>;
  readonly flush: () => Promise<LifecycleReport>;
  readonly close: () => Promise<LifecycleReport>;
  readonly dispose: () => Promise<LifecycleReport>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
};

export type NodeObservability = NodeObservabilityDisabled | NodeObservabilityEnabled;

const emptyReport = (operation: "flush" | "close"): LifecycleReport => ({
  operation,
  outcomes: [],
  durationMillis: 0,
  degraded: false,
});

const closedFlush = (): Promise<LifecycleReport> =>
  Effect.runPromise(
    new ObservabilityLifecycleError({
      code: "OBS_OBSERVABILITY_CLOSED",
      message: "Observability is closed. Create a new runtime before flushing again.",
      adapter: Option.none(),
      cause: "flush after close",
    }),
  );

const noopEventLayer = Layer.succeed(
  TelemetryEventSink,
  TelemetryEventSink.of({ record: () => Effect.void, recordBrowserBatch: () => Effect.void }),
);

const disabledHandle = (): NodeObservabilityDisabled => {
  const report = emptyReport("close");
  const closePromise = Promise.resolve(report);
  let closed = false;
  const close = () => {
    closed = true;
    return closePromise;
  };
  return {
    enabled: false,
    eventLayer: noopEventLayer,
    flush: () => (closed ? closedFlush() : Promise.resolve(emptyReport("flush"))),
    close,
    dispose: close,
    [Symbol.asyncDispose]: async () => {
      await close();
    },
  };
};

class LiveNodeObservability implements NodeObservabilityEnabled {
  readonly enabled = true;
  #closePromise: Promise<LifecycleReport> | undefined;
  #flushPromise: Promise<LifecycleReport> | undefined;
  #closed = false;

  constructor(
    readonly config: NodeObservabilityConfigEnabled,
    readonly runtime: ManagedRuntime.ManagedRuntime<
      OtlpExporter.Flusher,
      InvalidObservabilityConfig
    >,
    readonly eventLayer: Layer.Layer<TelemetryEventSink>,
    private readonly runLifecycle: (operation: "flush" | "close") => Effect.Effect<LifecycleReport>,
  ) {}

  flush(): Promise<LifecycleReport> {
    if (this.#closed) {
      return closedFlush();
    }
    if (this.#flushPromise !== undefined) {
      return this.#flushPromise;
    }
    const pending = Effect.runPromise(this.runLifecycle("flush"));
    this.#flushPromise = pending;
    const clear = () => {
      if (this.#flushPromise === pending) {
        this.#flushPromise = undefined;
      }
    };
    pending.then(clear, clear);
    return pending;
  }

  close(): Promise<LifecycleReport> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    const close = () => Effect.runPromise(this.runLifecycle("close"));
    const pendingFlush = this.#flushPromise;
    this.#closePromise = pendingFlush === undefined ? close() : pendingFlush.then(close, close);
    return this.#closePromise;
  }

  dispose(): Promise<LifecycleReport> {
    return this.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

type NodeObservabilityFactoryOptions = { readonly allowTesting: boolean };

export const acquireRuntimeFlusher = Effect.fn("acquireRuntimeFlusher")(function* (
  runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, InvalidObservabilityConfig>,
): Effect.fn.Return<
  OtlpExporter.Flusher["Service"],
  InvalidObservabilityConfig | ObservabilityLifecycleError
> {
  const acquisition = yield* Effect.promise(() => runtime.runPromiseExit(OtlpExporter.Flusher));
  if (acquisition._tag === "Failure") {
    yield* runtime.disposeEffect.pipe(Effect.catchCause(() => Effect.void));
    return yield* Option.getOrElse(
      Cause.findErrorOption(acquisition.cause),
      () =>
        new ObservabilityLifecycleError({
          code: "OBS_OBSERVABILITY_STARTUP_FAILED",
          message:
            "The built-in OpenTelemetry runtime failed to start. Verify the endpoint configuration.",
          adapter: Option.none(),
          cause: acquisition.cause,
        }),
    );
  }
  return acquisition.value;
});

const makeNodeObservabilityWithOptions = Effect.fn("makeNodeObservability")(function* (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<AdapterRegistration>,
  options: NodeObservabilityFactoryOptions,
): Effect.fn.Return<NodeObservability, InvalidObservabilityConfig | ObservabilityLifecycleError> {
  if (!config.enabled) {
    yield* validateAdapterRegistrationKinds(registrations, options);
    return disabledHandle();
  }
  yield* validateAdapterRegistrations(
    config.profile,
    config.identity.environment,
    registrations,
    options,
  );
  const runtime = ManagedRuntime.make(
    Telemetry.layer(config.telemetry, {
      shutdownTimeout: Duration.millis(400),
      policy: config.evlog.policy,
    }),
  );
  const flusher = yield* acquireRuntimeFlusher(runtime);
  const context = {
    profile: config.profile,
    identity: config.identity,
    telemetryConfig: config.telemetry,
    contract: config.evlog.contract,
    policy: config.evlog.policy,
    sentry: config.sentry,
    runtime,
  };
  const started: Array<StartedAdapter> = [];
  for (const registration of registrations.toSorted((left, right) => {
    const leftStage = config.profile.stages.indexOf(left.adapter.stage);
    const rightStage = config.profile.stages.indexOf(right.adapter.stage);
    return (
      leftStage - rightStage ||
      profileCapabilityRank(config.profile, left.adapter.stage, left.adapter.capability) -
        profileCapabilityRank(config.profile, right.adapter.stage, right.adapter.capability)
    );
  })) {
    const result = yield* registration.adapter.start(context).pipe(Effect.exit);
    if (result._tag === "Failure") {
      yield* rollbackStartedAdapters(started);
      yield* runtime.disposeEffect;
      return yield* new ObservabilityLifecycleError({
        code: "OBS_OBSERVABILITY_STARTUP_FAILED",
        message: `Observability adapter "${registration.adapter.name}" failed during startup. Fix its local configuration before retrying.`,
        adapter: Option.some(registration.adapter.name),
        cause: Option.getOrElse(Cause.findErrorOption(result.cause), () => result.cause),
      });
    }
    started.push({ registration, handle: result.value });
  }
  const eventHandle = started.find(
    (entry) => entry.registration.adapter.capability === "events",
  )?.handle;
  const eventLayer = eventHandle?.eventLayer ?? Option.none();
  if (Option.isNone(eventLayer)) {
    yield* rollbackStartedAdapters(started);
    yield* runtime.disposeEffect;
    return yield* new ObservabilityLifecycleError({
      code: "OBS_OBSERVABILITY_STARTUP_FAILED",
      message:
        "The events adapter did not provide its TelemetryEventSink layer. Use an official events adapter that owns event delivery.",
      adapter: Option.fromNullishOr(
        started.find((entry) => entry.registration.adapter.capability === "events")?.registration
          .adapter.name,
      ),
      cause: "missing events service layer",
    });
  }
  const registry = createLifecycleRegistry(config.profile, started, flusher, runtime.disposeEffect);
  return new LiveNodeObservability(config, runtime, eventLayer.value, registry.run);
});

export const makeNodeObservability = (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<AdapterRegistration>,
): Effect.Effect<NodeObservability, InvalidObservabilityConfig | ObservabilityLifecycleError> =>
  makeNodeObservabilityWithOptions(config, registrations, { allowTesting: false });

export const createNodeObservabilityFromConfig = (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<AdapterRegistration>,
): Promise<NodeObservability> => Effect.runPromise(makeNodeObservability(config, registrations));

export const createTestingNodeObservabilityFromConfig = (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<TestingAdapterRegistration>,
): Promise<NodeObservability> =>
  Effect.runPromise(
    makeNodeObservabilityWithOptions(config, registrations, { allowTesting: true }),
  );

export type CreateNodeObservabilityInput = EnvBootstrapInput & {
  readonly adapters: ReadonlyArray<AdapterRegistration>;
};

export const createNodeObservability = (
  input: CreateNodeObservabilityInput,
): Promise<NodeObservability> =>
  Effect.runPromise(
    nodeObservabilityConfigFromEnv(input).pipe(
      Effect.flatMap((config) => makeNodeObservability(config, input.adapters)),
    ),
  );

export class NodeObservabilityService extends Context.Service<
  NodeObservabilityService,
  NodeObservability
>()("@equipe-tech/observability/node/NodeObservability") {}

export const layerNodeObservability = (
  input: CreateNodeObservabilityInput,
): Layer.Layer<
  NodeObservabilityService,
  InvalidObservabilityConfig | DuplicateReleaseVariable | ObservabilityLifecycleError
> =>
  Layer.effect(
    NodeObservabilityService,
    Effect.acquireRelease(
      nodeObservabilityConfigFromEnv(input).pipe(
        Effect.flatMap((config) => makeNodeObservability(config, input.adapters)),
      ),
      (handle) => Effect.promise(() => handle.close()).pipe(Effect.asVoid),
    ),
  );
