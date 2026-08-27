import type {
  BeforeApplicationShutdown,
  CallHandler,
  DynamicModule,
  ExecutionContext,
  InjectionToken,
  ModuleMetadata,
  NestInterceptor,
  OnApplicationShutdown,
  OptionalFactoryDependency,
  Provider,
} from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Duration, Effect, ManagedRuntime, Option, Schema } from "effect";
import type { OtlpExporter } from "effect/unstable/observability";
import { OtlpExporter as Otlp } from "effect/unstable/observability";
import type { Observable } from "rxjs";
import { layer } from "../Telemetry.ts";
import { TelemetryConfig } from "../TelemetryConfig.ts";
import { telemetryRoutePolicy, type ProxyPolicy } from "./HttpRoutePolicy.ts";
import { TelemetryInterceptor, TelemetryRequestTracker } from "./TelemetryInterceptor.ts";

export type TelemetryModuleOptions =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly serviceName: string;
      readonly serviceVersion: string;
      readonly environment: string;
      readonly otlpEndpoint: string;
      readonly healthRouteTemplates?: ReadonlyArray<string> | undefined;
      readonly proxyPolicy?: ProxyPolicy | undefined;
      readonly shutdownTimeoutMilliseconds?: number | undefined;
    };

export interface TelemetryModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
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

const Identity = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value.trim() === value, { expected: "a nonempty trimmed string" }),
);
const Endpoint = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "",
    { expected: "an HTTP or HTTPS URL without credentials" },
  ),
);
const ShutdownTimeout = Schema.Number.check(
  Schema.isInt(),
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0, {
    expected: "a positive safe integer",
  }),
);
const EnabledOptions = Schema.Struct({
  enabled: Schema.Literal(true),
  serviceName: Identity,
  serviceVersion: Identity,
  environment: Identity,
  otlpEndpoint: Endpoint,
  healthRouteTemplates: Schema.Array(Schema.String).pipe(Schema.optionalKey),
  proxyPolicy: Schema.Literals(["direct", "framework"]).pipe(Schema.optionalKey),
  shutdownTimeoutMilliseconds: ShutdownTimeout.pipe(Schema.optionalKey),
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
        serviceName: options.serviceName,
        serviceVersion: options.serviceVersion,
        environment: options.environment,
        otlpEndpoint: options.otlpEndpoint,
      }),
      healthRouteTemplates: options.healthRouteTemplates,
      proxyPolicy: options.proxyPolicy ?? "direct",
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
  #shutdownPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #shutdownError: TelemetryShutdownError | undefined;

  constructor(
    runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>,
    flusher: OtlpExporter.Flusher["Service"],
    options: EnabledNormalizedOptions,
    releaseRuntime: () => Promise<void>,
  ) {
    this.#runtime = runtime;
    this.#flusher = flusher;
    this.#releaseRuntime = releaseRuntime;
    this.#requestTracker = new TelemetryRequestTracker();
    this.#shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds;
    this.interceptor = new TelemetryInterceptor(runtime, {
      healthRouteTemplates: options.healthRouteTemplates,
      proxyPolicy: options.proxyPolicy,
      requestTracker: this.#requestTracker,
    });
  }

  beforeApplicationShutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown();
    return this.#shutdownPromise;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.beforeApplicationShutdown();
    this.#disposePromise ??= this.#releaseRuntime();
    try {
      await this.#disposePromise;
    } catch (cause) {
      this.#shutdownError ??= new TelemetryShutdownError(cause);
    }
    if (this.#shutdownError !== undefined) {
      throw this.#shutdownError;
    }
  }

  async #shutdown(): Promise<void> {
    const deadline = Date.now() + this.#shutdownTimeoutMilliseconds;
    this.#requestTracker.closeAdmission();
    const idle = await this.#withinDeadline(this.#requestTracker.waitForIdle(), deadline);
    if (!idle) {
      this.#requestTracker.interruptActive();
      await this.#requestTracker.waitForIdle();
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      this.#shutdownError = new TelemetryShutdownError(
        new Error("The telemetry request drain exhausted the shutdown deadline."),
      );
      return;
    }
    try {
      const flushed = await this.#runtime.runPromise(
        this.#flusher.flush.pipe(Effect.timeoutOption(Duration.millis(remaining))),
      );
      if (Option.isNone(flushed)) {
        this.#shutdownError = new TelemetryShutdownError(
          new Error("The telemetry flush exceeded the shutdown deadline."),
        );
      }
    } catch (cause) {
      this.#shutdownError = new TelemetryShutdownError(cause);
    }
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

const ASYNC_OPTIONS = Symbol("TelemetryModuleAsyncOptions");
const NORMALIZED_OPTIONS = Symbol("TelemetryModuleNormalizedOptions");
const TELEMETRY_INTEGRATION = Symbol("TelemetryModuleIntegration");

interface SharedRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
  readonly flusher: OtlpExporter.Flusher["Service"];
  references: number;
}

interface RuntimeLease {
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
  readonly flusher: OtlpExporter.Flusher["Service"];
  readonly release: () => Promise<void>;
}

const runtimePool = new Map<string, Promise<SharedRuntime>>();

const runtimeKey = (options: EnabledNormalizedOptions): string =>
  JSON.stringify([
    options.config.otlpEndpoint.toString(),
    options.config.serviceName,
    options.config.serviceVersion,
    options.config.environment,
    options.shutdownTimeoutMilliseconds,
  ]);

const createSharedRuntime = async (options: EnabledNormalizedOptions): Promise<SharedRuntime> => {
  const runtime = ManagedRuntime.make(
    layer(options.config, {
      shutdownTimeout: Duration.millis(options.shutdownTimeoutMilliseconds),
    }),
  );
  try {
    await runtime.context();
    const flusher = await runtime.runPromise(Otlp.Flusher);
    return { runtime, flusher, references: 0 };
  } catch (cause) {
    try {
      await runtime.dispose();
    } catch (disposeCause) {
      throw new TelemetryStartupError(new AggregateError([cause, disposeCause]));
    }
    throw new TelemetryStartupError(cause);
  }
};

const acquireRuntime = async (options: EnabledNormalizedOptions): Promise<RuntimeLease> => {
  const key = runtimeKey(options);
  let sharedPromise = runtimePool.get(key);
  if (sharedPromise === undefined) {
    sharedPromise = createSharedRuntime(options);
    runtimePool.set(key, sharedPromise);
    sharedPromise.catch(() => {
      if (runtimePool.get(key) === sharedPromise) {
        runtimePool.delete(key);
      }
    });
  }
  const shared = await sharedPromise;
  shared.references++;
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasePromise !== undefined) {
      return releasePromise;
    }
    shared.references--;
    if (shared.references > 0) {
      releasePromise = Promise.resolve();
      return releasePromise;
    }
    if (runtimePool.get(key) === sharedPromise) {
      runtimePool.delete(key);
    }
    releasePromise = shared.runtime.dispose();
    return releasePromise;
  };
  return { runtime: shared.runtime, flusher: shared.flusher, release };
};

const makeIntegration = async (options: NormalizedOptions): Promise<TelemetryIntegration> => {
  if (!options.enabled) {
    return new DisabledTelemetryIntegration();
  }
  const lease = await acquireRuntime(options);
  return new EnabledTelemetryIntegration(lease.runtime, lease.flusher, options, lease.release);
};

export class TelemetryModule {
  static forRootAsync(options: TelemetryModuleAsyncOptions): DynamicModule {
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
        inject: [NORMALIZED_OPTIONS],
        useFactory: makeIntegration,
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
  }
}

Module({})(TelemetryModule);
