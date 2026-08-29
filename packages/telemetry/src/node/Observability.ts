import { Context, Duration, Effect, Layer, ManagedRuntime, Option } from "effect";
import { OtlpExporter } from "effect/unstable/observability";
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
} from "../profile/ObservabilityAdapter.ts";
import {
  createLifecycleRegistry,
  ObservabilityLifecycleError,
  rollbackStartedAdapters,
  validateAdapterRegistrations,
} from "../profile/LifecycleRegistry.ts";
import type {
  DuplicateReleaseVariable,
  InvalidObservabilityConfig,
} from "../profile/ObservabilityConfigError.ts";

export type NodeObservabilityDisabled = {
  readonly enabled: false;
  readonly flush: () => Promise<LifecycleReport>;
  readonly close: () => Promise<LifecycleReport>;
  readonly dispose: () => Promise<LifecycleReport>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
};

export type NodeObservabilityEnabled = {
  readonly enabled: true;
  readonly config: NodeObservabilityConfigEnabled;
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
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

const disabledHandle = (): NodeObservabilityDisabled => {
  const report = emptyReport("close");
  return {
    enabled: false,
    flush: () => Promise.resolve(emptyReport("flush")),
    close: () => Promise.resolve(report),
    dispose: () => Promise.resolve(report),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
};

class LiveNodeObservability implements NodeObservabilityEnabled {
  readonly enabled = true;
  #closePromise: Promise<LifecycleReport> | undefined;
  #flushPromise: Promise<LifecycleReport> | undefined;
  #closed = false;

  constructor(
    readonly config: NodeObservabilityConfigEnabled,
    readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>,
    private readonly runLifecycle: (operation: "flush" | "close") => Effect.Effect<LifecycleReport>,
  ) {}

  flush(): Promise<LifecycleReport> {
    if (this.#closed) {
      return Effect.runPromise(
        new ObservabilityLifecycleError({
          code: "OBS_OBSERVABILITY_CLOSED",
          message: "Observability is closed. Create a new runtime before flushing again.",
          adapter: Option.none(),
          cause: "flush after close",
        }),
      );
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
    this.#closePromise = Effect.runPromise(this.runLifecycle("close"));
    return this.#closePromise;
  }

  dispose(): Promise<LifecycleReport> {
    return this.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

const stageRank = (registration: AdapterRegistration): number => {
  const capability = registration.adapter.capability;
  if (capability === "events") return 0;
  if (capability === "traces") return 1;
  if (capability === "defects") return 2;
  if (capability === "metrics") return 3;
  return 4;
};

export const makeNodeObservability = Effect.fn("makeNodeObservability")(function* (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<AdapterRegistration>,
): Effect.fn.Return<NodeObservability, InvalidObservabilityConfig | ObservabilityLifecycleError> {
  if (!config.enabled) {
    return disabledHandle();
  }
  yield* validateAdapterRegistrations(config.profile, config.identity.environment, registrations);
  const runtime = ManagedRuntime.make(
    Telemetry.layer(config.telemetry, { shutdownTimeout: Duration.millis(5_000) }),
  );
  const flusher = yield* Effect.tryPromise({
    try: () => runtime.runPromise(OtlpExporter.Flusher),
    catch: (cause) =>
      new ObservabilityLifecycleError({
        code: "OBS_OBSERVABILITY_STARTUP_FAILED",
        message:
          "The built-in OpenTelemetry runtime failed to start. Verify the endpoint configuration.",
        adapter: Option.none(),
        cause,
      }),
  });
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
  for (const registration of registrations.toSorted(
    (left, right) => stageRank(left) - stageRank(right),
  )) {
    const result = yield* registration.adapter.start(context).pipe(Effect.exit);
    if (result._tag === "Failure") {
      yield* rollbackStartedAdapters(started);
      yield* runtime.disposeEffect;
      return yield* new ObservabilityLifecycleError({
        code: "OBS_OBSERVABILITY_STARTUP_FAILED",
        message: `Observability adapter "${registration.adapter.name}" failed during startup. Fix its local configuration before retrying.`,
        adapter: Option.some(registration.adapter.name),
        cause: result.cause,
      });
    }
    started.push({ registration, handle: result.value });
  }
  const registry = createLifecycleRegistry(config.profile, started, flusher, runtime.disposeEffect);
  return new LiveNodeObservability(config, runtime, registry.run);
});

export const createNodeObservabilityFromConfig = (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<AdapterRegistration>,
): Promise<NodeObservability> => Effect.runPromise(makeNodeObservability(config, registrations));

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
