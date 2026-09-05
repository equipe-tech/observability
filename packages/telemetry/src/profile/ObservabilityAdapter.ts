import { Effect, Layer, ManagedRuntime, Option, Predicate, Schema } from "effect";
import type { OtlpExporter } from "effect/unstable/observability";
import type {
  CompiledAuditActionDefinition,
  CompiledEventDefinition,
} from "../contract/TelemetryContract.ts";
import type { CompiledMetricDefinition } from "../contract/MetricDefinition.ts";
import type { EventName } from "../contract/EventName.ts";
import type { AuditPublisher } from "../audit/AuditPublisher.ts";
import type { TelemetryEventSink } from "../contract/EventProducer.ts";
import type { ResourceIdentity } from "../ResourceIdentity.ts";
import type { TelemetryConfig } from "../TelemetryConfig.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import type { SentryConfig } from "./ObservabilityConfig.ts";
import { InvalidObservabilityConfig } from "./ObservabilityConfigError.ts";
import type {
  AdapterCapability,
  LifecycleStage,
  ObservabilityProfile,
} from "./ObservabilityProfile.ts";

export const AdapterName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
).pipe(Schema.brand("AdapterName"));
export type AdapterName = typeof AdapterName.Type;

export class AdapterFailure extends Schema.TaggedError<AdapterFailure>()("AdapterFailure", {
  code: Schema.Literal("OBS_OBSERVABILITY_ADAPTER_FAILED"),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ContractRegistry = {
  readonly version: 1;
  readonly eventNames: ReadonlyArray<EventName>;
  readonly eventByAlias: ReadonlyMap<string, CompiledEventDefinition>;
  readonly eventByName: ReadonlyMap<EventName, CompiledEventDefinition>;
  readonly auditActionByAlias: ReadonlyMap<string, CompiledAuditActionDefinition>;
  readonly auditActionByName: ReadonlyMap<string, CompiledAuditActionDefinition>;
  readonly metricByAlias: ReadonlyMap<string, CompiledMetricDefinition>;
  readonly metricByName: ReadonlyMap<string, CompiledMetricDefinition>;
};

export type ObservabilityAdapterContext = {
  readonly profile: ObservabilityProfile;
  readonly identity: ResourceIdentity;
  readonly telemetryConfig: TelemetryConfig;
  readonly contract: ContractRegistry;
  readonly policy: DataPolicy;
  readonly sentry: SentryConfig;
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, InvalidObservabilityConfig>;
};

export type ObservabilityAdapterHandle = {
  readonly flush: Effect.Effect<void, AdapterFailure>;
  readonly close: Effect.Effect<void, AdapterFailure>;
  readonly eventLayer: Option.Option<Layer.Layer<TelemetryEventSink>>;
  readonly auditLayer: Option.Option<Layer.Layer<AuditPublisher>>;
  readonly degraded: () => boolean;
};

export type ObservabilityAdapter = {
  readonly name: AdapterName;
  readonly capability: AdapterCapability;
  readonly stage: LifecycleStage;
  readonly start: (
    context: ObservabilityAdapterContext,
  ) => Effect.Effect<ObservabilityAdapterHandle, AdapterFailure>;
};

const officialRegistrationBrand: unique symbol = Symbol("OfficialAdapterRegistration");
const testingRegistrationBrand: unique symbol = Symbol("TestingAdapterRegistration");
const officialRegistrations = new WeakSet<OfficialAdapterRegistration>();
const testingRegistrations = new WeakSet<TestingAdapterRegistration>();

export type OfficialAdapterRegistration = {
  readonly kind: "official";
  readonly adapter: ObservabilityAdapter;
  readonly [officialRegistrationBrand]: true;
};

export type TestingAdapterRegistration = {
  readonly kind: "testing";
  readonly adapter: ObservabilityAdapter;
  readonly [testingRegistrationBrand]: true;
};

export type AdapterRegistration = OfficialAdapterRegistration | TestingAdapterRegistration;

const AdapterRegistrationPayload = Schema.Struct({
  name: AdapterName,
  capability: Schema.Literals(["events", "traces", "metrics", "defects", "browser-ingest"]),
  stage: Schema.Literals(["server", "metrics", "browser"]),
});

const parseAdapterRegistrationPayload = (adapter: ObservabilityAdapter): ObservabilityAdapter => {
  const decoded = Schema.decodeUnknownOption(AdapterRegistrationPayload)(adapter);
  if (Option.isNone(decoded) || !Predicate.isFunction(adapter.start)) {
    throw new InvalidObservabilityConfig({
      code: "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
      field: "adapters",
      message:
        "The adapter payload is invalid. Use a valid adapter name, capability, lifecycle stage, and callable start.",
      rule: "a schema-valid adapter payload with a callable start",
    });
  }
  return Object.freeze(adapter);
};

export const registerOfficialAdapter = (
  adapter: ObservabilityAdapter,
): OfficialAdapterRegistration => {
  const registration: OfficialAdapterRegistration = {
    kind: "official",
    adapter: parseAdapterRegistrationPayload(adapter),
    [officialRegistrationBrand]: true,
  };
  officialRegistrations.add(registration);
  return Object.freeze(registration);
};

export const registerTestingAdapter = (
  adapter: ObservabilityAdapter,
): TestingAdapterRegistration => {
  const registration: TestingAdapterRegistration = {
    kind: "testing",
    adapter: parseAdapterRegistrationPayload(adapter),
    [testingRegistrationBrand]: true,
  };
  testingRegistrations.add(registration);
  return Object.freeze(registration);
};

export const isOfficialAdapterRegistration = (
  registration: AdapterRegistration,
): registration is OfficialAdapterRegistration =>
  registration.kind === "official" && officialRegistrations.has(registration);

export const isTestingAdapterRegistration = (
  registration: AdapterRegistration,
): registration is TestingAdapterRegistration =>
  registration.kind === "testing" && testingRegistrations.has(registration);

export type LifecycleCleanupResult =
  | { readonly kind: "completed"; readonly durationMillis: number }
  | { readonly kind: "failed"; readonly error: AdapterFailure }
  | { readonly kind: "deadline-exceeded"; readonly budgetMillis: number };

export type LifecycleOutcomeResult =
  | { readonly kind: "completed"; readonly durationMillis: number }
  | { readonly kind: "failed"; readonly error: AdapterFailure }
  | {
      readonly kind: "deadline-exceeded";
      readonly budgetMillis: number;
      readonly forcedCleanup?: LifecycleCleanupResult;
    };

export type AdapterOutcome = {
  readonly participant: "adapter";
  readonly adapter: AdapterName;
  readonly capability: AdapterCapability;
  readonly stage: LifecycleStage;
  readonly result: LifecycleOutcomeResult;
};

export type RuntimeDisposalOutcome = {
  readonly participant: "runtime-disposal";
  readonly result: LifecycleOutcomeResult;
};

export type LifecycleOutcome = AdapterOutcome | RuntimeDisposalOutcome;

export type LifecycleReport = {
  readonly operation: "flush" | "close";
  readonly outcomes: ReadonlyArray<LifecycleOutcome>;
  readonly durationMillis: number;
  readonly degraded: boolean;
};

export type StartedAdapter = {
  readonly registration: AdapterRegistration;
  readonly handle: ObservabilityAdapterHandle;
};
