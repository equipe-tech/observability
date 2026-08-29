import type {
  BeforeApplicationShutdown,
  CallHandler,
  DynamicModule,
  ExecutionContext,
  InjectionToken,
  ModuleMetadata,
  NestInterceptor,
  OnApplicationShutdown,
  OnModuleInit,
  OptionalFactoryDependency,
  Provider,
} from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, HttpAdapterHost } from "@nestjs/core";
import { Duration, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import type { OtlpExporter } from "effect/unstable/observability";
import { OtlpExporter as Otlp } from "effect/unstable/observability";
import type { Observable } from "rxjs";
import {
  EnvironmentAliasPolicy,
  EnvironmentName,
  ServiceInstanceId,
  ServiceName,
  ServiceVersion,
} from "../ResourceIdentity.ts";
import { layer } from "../Telemetry.ts";
import { OtlpEndpoint, TelemetryConfig } from "../TelemetryConfig.ts";
import { telemetryRoutePolicy, type ProxyPolicy } from "./HttpRoutePolicy.ts";
import { RequestWideEventTraceCorrelation } from "./RequestWideEventTraceCorrelation.ts";
import { TelemetryInterceptor, TelemetryRequestTracker } from "./TelemetryInterceptor.ts";

export type TelemetryModuleOptions =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly serviceName: string;
      readonly serviceVersion: string;
      readonly environment: string;
      readonly serviceInstanceId?: string | undefined;
      readonly deploymentEnvironmentAlias?: EnvironmentAliasPolicy | undefined;
      readonly otlpEndpoint: string;
      readonly healthRouteTemplates?: ReadonlyArray<string> | undefined;
      readonly proxyPolicy?: ProxyPolicy | undefined;
      readonly requestWideEventTraceCorrelation?: RequestWideEventTraceCorrelation | undefined;
      readonly shutdownTimeoutMilliseconds?: number | undefined;
    };

export interface TelemetryModuleAsyncOptions {
  readonly imports?: ModuleMetadata["imports"] | undefined;
  readonly inject?: Array<InjectionToken | OptionalFactoryDependency> | undefined;
  readonly useFactory: (
    ...dependencies: Array<never>
  ) => TelemetryModuleOptions | Promise<TelemetryModuleOptions>;
}

export class InvalidTelemetryModuleOptions extends Error {
  readonly _tag = "InvalidTelemetryModuleOptions";
  readonly code = "OBS_TELEMETRY_INVALID_MODULE_OPTIONS";
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "Telemetry module options are invalid. Provide valid service identity, HTTP OTLP endpoint, route templates, proxy policy, and shutdown timeout.",
      { cause },
    );
    this.name = "InvalidTelemetryModuleOptions";
    this.cause = cause;
  }
}

export class TelemetryStartupError extends Error {
  readonly _tag = "TelemetryStartupError";
  readonly code = "OBS_TELEMETRY_STARTUP_FAILED";
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "Telemetry startup failed. Verify the OTLP transport and runtime configuration before restarting the application.",
      { cause },
    );
    this.name = "TelemetryStartupError";
    this.cause = cause;
  }
}

export class TelemetryShutdownError extends Error {
  readonly _tag = "TelemetryShutdownError";
  readonly code = "OBS_TELEMETRY_SHUTDOWN_FAILED";
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "Telemetry shutdown failed. Telemetry resources were disposed, but the final drain or flush did not complete.",
      { cause },
    );
    this.name = "TelemetryShutdownError";
    this.cause = cause;
  }
}

const ShutdownTimeout = Schema.Number.check(
  Schema.isInt(),
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0, {
    expected: "a positive safe integer",
  }),
);
const EnabledOptions = Schema.Struct({
  enabled: Schema.Literal(true),
  serviceName: ServiceName,
  serviceVersion: ServiceVersion,
  environment: EnvironmentName,
  serviceInstanceId: Schema.Union([ServiceInstanceId, Schema.Undefined]).pipe(Schema.optionalKey),
  deploymentEnvironmentAlias: Schema.Union([EnvironmentAliasPolicy, Schema.Undefined]).pipe(
    Schema.optionalKey,
  ),
  otlpEndpoint: OtlpEndpoint,
  healthRouteTemplates: Schema.Union([Schema.Array(Schema.String), Schema.Undefined]).pipe(
    Schema.optionalKey,
  ),
  proxyPolicy: Schema.Union([Schema.Literals(["direct", "framework"]), Schema.Undefined]).pipe(
    Schema.optionalKey,
  ),
  requestWideEventTraceCorrelation: Schema.Union([
    Schema.instanceOf(RequestWideEventTraceCorrelation),
    Schema.Undefined,
  ]).pipe(Schema.optionalKey),
  shutdownTimeoutMilliseconds: Schema.Union([ShutdownTimeout, Schema.Undefined]).pipe(
    Schema.optionalKey,
  ),
});
const DisabledOptions = Schema.Struct({ enabled: Schema.Literal(false) });
const ModuleOptions = Schema.Union([DisabledOptions, EnabledOptions]);
const decodeModuleOptions = Schema.decodeUnknownSync(ModuleOptions);

interface DisabledNormalizedOptions {
  readonly enabled: false;
}

interface EnabledNormalizedOptions {
  readonly enabled: true;
  readonly config: TelemetryConfig;
  readonly healthRouteTemplates: ReadonlyArray<string> | undefined;
  readonly proxyPolicy: ProxyPolicy;
  readonly requestWideEventTraceCorrelation: RequestWideEventTraceCorrelation | undefined;
  readonly shutdownTimeoutMilliseconds: number;
}

type NormalizedOptions = DisabledNormalizedOptions | EnabledNormalizedOptions;

const parseModuleOptions = (input: TelemetryModuleOptions): NormalizedOptions => {
  try {
    const options = decodeModuleOptions(input);
    if (!options.enabled) {
      return { enabled: false };
    }
    telemetryRoutePolicy({
      healthRouteTemplates: options.healthRouteTemplates,
      proxyPolicy: options.proxyPolicy,
    });
    return {
      enabled: true,
      config: new TelemetryConfig({
        identity: {
          serviceName: options.serviceName,
          serviceVersion: options.serviceVersion,
          environment: options.environment,
          instance: Option.fromNullishOr(options.serviceInstanceId),
        },
        environmentAlias: options.deploymentEnvironmentAlias ?? "omitted",
        otlpEndpoint: options.otlpEndpoint,
      }),
      healthRouteTemplates: options.healthRouteTemplates,
      proxyPolicy: options.proxyPolicy ?? "direct",
      requestWideEventTraceCorrelation: options.requestWideEventTraceCorrelation,
      shutdownTimeoutMilliseconds: options.shutdownTimeoutMilliseconds ?? 5_000,
    };
  } catch (cause) {
    throw new InvalidTelemetryModuleOptions(cause);
  }
};

class DisabledTelemetryInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}

interface TelemetryIntegration extends BeforeApplicationShutdown, OnApplicationShutdown {
  readonly interceptor: NestInterceptor;
}

class DisabledTelemetryIntegration implements TelemetryIntegration {
  readonly interceptor = new DisabledTelemetryInterceptor();

  beforeApplicationShutdown(): void {}

  onApplicationShutdown(): void {}
}

class EnabledTelemetryIntegration implements TelemetryIntegration {
  readonly interceptor: NestInterceptor;
  readonly #runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
  readonly #flusher: OtlpExporter.Flusher["Service"];
  readonly #requestTracker: TelemetryRequestTracker;
  readonly #shutdownTimeoutMilliseconds: number;
  readonly #releaseRuntime: () => Promise<void>;
  readonly #beforeRequestDrain: () => void | Promise<void>;
  #shutdownPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #shutdownError: TelemetryShutdownError | undefined;

  constructor(
    runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>,
    flusher: OtlpExporter.Flusher["Service"],
    options: EnabledNormalizedOptions,
    releaseRuntime: () => Promise<void>,
    beforeRequestDrain: () => void | Promise<void>,
  ) {
    this.#runtime = runtime;
    this.#flusher = flusher;
    this.#releaseRuntime = releaseRuntime;
    this.#beforeRequestDrain = beforeRequestDrain;
    this.#requestTracker = new TelemetryRequestTracker();
    this.#shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds;
    this.interceptor = new TelemetryInterceptor(runtime, {
      healthRouteTemplates: options.healthRouteTemplates,
      proxyPolicy: options.proxyPolicy,
      requestTracker: this.#requestTracker,
      requestWideEventTraceCorrelation: options.requestWideEventTraceCorrelation,
    });
  }

  beforeApplicationShutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown();
    return this.#shutdownPromise;
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.beforeApplicationShutdown();
    } catch (cause) {
      this.#recordShutdownError(cause);
    } finally {
      this.#disposePromise ??= this.#releaseRuntime();
      try {
        await this.#disposePromise;
      } catch (cause) {
        this.#recordShutdownError(cause);
      }
    }
    if (this.#shutdownError !== undefined) {
      throw this.#shutdownError;
    }
  }

  async #shutdown(): Promise<void> {
    const deadline = Date.now() + this.#shutdownTimeoutMilliseconds;
    try {
      this.#requestTracker.closeAdmission();
      await this.#beforeRequestDrain();
      const idle = await this.#withinDeadline(this.#requestTracker.waitForIdle(), deadline);
      if (!idle) {
        this.#requestTracker.interruptActive();
        const interrupted = await this.#withinDeadline(
          this.#requestTracker.waitForIdle(),
          deadline,
        );
        if (!interrupted) {
          this.#recordShutdownError(
            new Error("The telemetry request interruption exhausted the shutdown deadline."),
          );
        }
      }
    } catch (cause) {
      this.#recordShutdownError(cause);
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      this.#recordShutdownError(
        new Error("The telemetry request drain exhausted the shutdown deadline."),
      );
      return;
    }
    try {
      const flushed = await this.#runtime.runPromise(
        this.#flusher.flush.pipe(Effect.timeoutOption(Duration.millis(remaining))),
      );
      if (Option.isNone(flushed)) {
        this.#recordShutdownError(new Error("The telemetry flush exceeded the shutdown deadline."));
      }
    } catch (cause) {
      this.#recordShutdownError(cause);
    }
  }

  #recordShutdownError(cause: unknown): void {
    if (this.#shutdownError === undefined) {
      this.#shutdownError =
        cause instanceof TelemetryShutdownError ? cause : new TelemetryShutdownError(cause);
      return;
    }
    this.#shutdownError = new TelemetryShutdownError(
      new AggregateError([this.#shutdownError.cause, cause]),
    );
  }

  async #withinDeadline(operation: Promise<void>, deadline: number): Promise<boolean> {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    });
    const completed = operation.then(() => true);
    try {
      return await Promise.race([completed, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

class DeferredTelemetryInterceptor implements NestInterceptor {
  #target: NestInterceptor | undefined;

  setTarget(target: NestInterceptor): void {
    this.#target = target;
  }

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    return this.#target?.intercept(context, next) ?? next.handle();
  }
}

class PendingTelemetryIntegration implements TelemetryIntegration, OnModuleInit {
  readonly interceptor = new DeferredTelemetryInterceptor();
  readonly #application: WeakKey;
  readonly #options: EnabledNormalizedOptions;
  readonly #state: ApplicationRuntimeState;
  readonly #overrides: TelemetryModuleTestingOverrides;
  #integration: EnabledTelemetryIntegration | undefined;

  constructor(
    application: WeakKey,
    options: EnabledNormalizedOptions,
    state: ApplicationRuntimeState,
    overrides: TelemetryModuleTestingOverrides,
  ) {
    this.#application = application;
    this.#options = options;
    this.#state = state;
    this.#overrides = overrides;
  }

  async onModuleInit(): Promise<void> {
    const lease = await acquireApplicationRuntime(
      this.#application,
      this.#state,
      this.#options,
      this.#overrides,
    );
    this.#integration = new EnabledTelemetryIntegration(
      lease.runtime,
      lease.flusher,
      this.#options,
      lease.release,
      this.#overrides.beforeRequestDrain ?? (() => undefined),
    );
    this.interceptor.setTarget(this.#integration.interceptor);
  }

  beforeApplicationShutdown(): void | Promise<void> {
    return this.#integration?.beforeApplicationShutdown();
  }

  onApplicationShutdown(): void | Promise<void> {
    return this.#integration?.onApplicationShutdown();
  }
}

const ASYNC_OPTIONS = Symbol("TelemetryModuleAsyncOptions");
const NORMALIZED_OPTIONS = Symbol("TelemetryModuleNormalizedOptions");
const TELEMETRY_INTEGRATION = Symbol("TelemetryModuleIntegration");

interface SharedRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
  readonly flusher: OtlpExporter.Flusher["Service"];
}

interface RuntimePoolEntry {
  readonly shared: Promise<SharedRuntime>;
  references: number;
  closing: Promise<void> | undefined;
}

interface RuntimeLease {
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
  readonly flusher: OtlpExporter.Flusher["Service"];
  readonly release: () => Promise<void>;
}

export interface TelemetryModuleTestingOverrides {
  readonly scopedResource?:
    | {
        readonly acquire: () => void | Promise<void>;
        readonly release: () => void | Promise<void>;
      }
    | undefined;
  readonly startupProbe?: (() => void | Promise<void>) | undefined;
  readonly beforeRequestDrain?: (() => void | Promise<void>) | undefined;
  readonly beforeRuntimeDispose?: (() => void | Promise<void>) | undefined;
  readonly onRuntimeDisposed?: (() => void) | undefined;
}

const runtimePool = new Map<string, RuntimePoolEntry>();

interface ApplicationRuntimeState {
  readonly key: string;
  readonly requestWideEventTraceCorrelation: RequestWideEventTraceCorrelation | undefined;
  readonly releases: Set<() => Promise<void>>;
  failed: boolean;
}

const applicationRuntimes = new WeakMap<WeakKey, ApplicationRuntimeState>();

const runtimeKey = (options: EnabledNormalizedOptions): string =>
  JSON.stringify([
    options.config.otlpEndpoint.toString(),
    options.config.identity.serviceName,
    options.config.identity.serviceVersion,
    options.config.identity.environment,
    Option.getOrUndefined(options.config.identity.instance),
    options.config.environmentAlias,
    options.shutdownTimeoutMilliseconds,
  ]);

const createSharedRuntime = async (
  options: EnabledNormalizedOptions,
  overrides: TelemetryModuleTestingOverrides,
): Promise<SharedRuntime> => {
  let runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never> | undefined;
  try {
    let runtimeLayer = layer(options.config, {
      shutdownTimeout: Duration.millis(options.shutdownTimeoutMilliseconds),
    });
    if (overrides.scopedResource !== undefined) {
      const resource = overrides.scopedResource;
      const resourceLayer = Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.promise(() => Promise.resolve(resource.acquire())),
          () => Effect.promise(() => Promise.resolve(resource.release())),
        ),
      );
      runtimeLayer = Layer.merge(runtimeLayer, resourceLayer);
    }
    runtime = ManagedRuntime.make(runtimeLayer);
    await runtime.context();
    await (overrides.startupProbe ?? (() => undefined))();
    const flusher = await runtime.runPromise(Otlp.Flusher);
    return { runtime, flusher };
  } catch (cause) {
    if (runtime !== undefined) {
      try {
        await runtime.dispose();
        overrides.onRuntimeDisposed?.();
      } catch (disposeCause) {
        throw new TelemetryStartupError(new AggregateError([cause, disposeCause]));
      }
    }
    throw new TelemetryStartupError(cause);
  }
};

const acquireRuntime = async (
  options: EnabledNormalizedOptions,
  overrides: TelemetryModuleTestingOverrides,
): Promise<RuntimeLease> => {
  const key = runtimeKey(options);
  let entry = runtimePool.get(key);
  if (entry?.closing !== undefined) {
    try {
      await entry.closing;
    } catch (cause) {
      throw new TelemetryStartupError(cause);
    }
    entry = runtimePool.get(key);
  }
  if (entry === undefined) {
    const shared = createSharedRuntime(options, overrides);
    entry = { shared, references: 0, closing: undefined };
    runtimePool.set(key, entry);
    try {
      await shared;
    } catch (cause) {
      if (runtimePool.get(key) === entry) {
        runtimePool.delete(key);
      }
      throw cause;
    }
  }
  const shared = await entry.shared;
  entry.references++;
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasePromise !== undefined) {
      return releasePromise;
    }
    entry.references--;
    if (entry.references > 0) {
      releasePromise = Promise.resolve();
      return releasePromise;
    }
    entry.closing = (async () => {
      let failure: Error | undefined;
      try {
        await overrides.beforeRuntimeDispose?.();
      } catch (cause) {
        failure = new Error("Telemetry runtime disposal preparation failed.", { cause });
      }
      try {
        await shared.runtime.dispose();
        overrides.onRuntimeDisposed?.();
      } catch (cause) {
        failure =
          failure === undefined
            ? new Error("Telemetry runtime disposal failed.", { cause })
            : new AggregateError([failure, cause]);
      }
      if (failure !== undefined) {
        throw failure;
      }
    })().finally(() => {
      if (runtimePool.get(key) === entry) {
        runtimePool.delete(key);
      }
    });
    releasePromise = entry.closing;
    return releasePromise;
  };
  return { runtime: shared.runtime, flusher: shared.flusher, release };
};

const registerApplicationRuntime = (
  application: WeakKey,
  options: EnabledNormalizedOptions,
): ApplicationRuntimeState => {
  const key = runtimeKey(options);
  const state = applicationRuntimes.get(application);
  if (state === undefined) {
    const registered = {
      key,
      requestWideEventTraceCorrelation: options.requestWideEventTraceCorrelation,
      releases: new Set<() => Promise<void>>(),
      failed: false,
    };
    applicationRuntimes.set(application, registered);
    return registered;
  }
  if (
    state.key !== key ||
    state.requestWideEventTraceCorrelation !== options.requestWideEventTraceCorrelation
  ) {
    state.failed = true;
  }
  return state;
};

const acquireApplicationRuntime = async (
  application: WeakKey,
  state: ApplicationRuntimeState,
  options: EnabledNormalizedOptions,
  overrides: TelemetryModuleTestingOverrides,
): Promise<RuntimeLease> => {
  if (state.failed) {
    applicationRuntimes.delete(application);
    throw new InvalidTelemetryModuleOptions(
      new Error("TelemetryModule imports in one application must use one telemetry configuration."),
    );
  }
  const lease = await acquireRuntime(options, overrides);
  const release = (): Promise<void> => {
    state.releases.delete(release);
    if (state.releases.size === 0) {
      applicationRuntimes.delete(application);
    }
    return lease.release();
  };
  state.releases.add(release);
  return { runtime: lease.runtime, flusher: lease.flusher, release };
};

const makeIntegration = (
  options: NormalizedOptions,
  application: WeakKey,
  overrides: TelemetryModuleTestingOverrides,
): TelemetryIntegration => {
  if (!options.enabled) {
    return new DisabledTelemetryIntegration();
  }
  return new PendingTelemetryIntegration(
    application,
    options,
    registerApplicationRuntime(application, options),
    overrides,
  );
};

const makeTelemetryModule = (
  options: TelemetryModuleAsyncOptions,
  overrides: TelemetryModuleTestingOverrides = {},
): DynamicModule => {
  const providers: Array<Provider> = [
    {
      provide: ASYNC_OPTIONS,
      inject: options.inject ?? [],
      useFactory: options.useFactory,
    },
    {
      provide: NORMALIZED_OPTIONS,
      inject: [ASYNC_OPTIONS],
      useFactory: parseModuleOptions,
    },
    {
      provide: TELEMETRY_INTEGRATION,
      inject: [NORMALIZED_OPTIONS, HttpAdapterHost],
      useFactory: (normalized: NormalizedOptions, application: HttpAdapterHost) =>
        makeIntegration(normalized, application, overrides),
    },
    {
      provide: APP_INTERCEPTOR,
      inject: [TELEMETRY_INTEGRATION],
      useFactory: (integration: TelemetryIntegration) => integration.interceptor,
    },
  ];
  if (options.imports === undefined) {
    return { module: TelemetryModule, providers };
  }
  return { module: TelemetryModule, imports: options.imports, providers };
};

export const telemetryModuleForTesting = (
  options: TelemetryModuleAsyncOptions,
  overrides: TelemetryModuleTestingOverrides,
): DynamicModule => makeTelemetryModule(options, overrides);

export class TelemetryModule {
  static forRootAsync(options: TelemetryModuleAsyncOptions): DynamicModule {
    return makeTelemetryModule(options);
  }
}

Module({})(TelemetryModule);
