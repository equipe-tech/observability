import { Effect, ManagedRuntime, Schema } from "effect";
import type {
  CompiledAuditActionDefinition,
  CompiledEventDefinition,
} from "../contract/TelemetryContract.ts";
import type { EventName } from "../contract/EventName.ts";
import type { ResourceIdentity } from "../ResourceIdentity.ts";
import type { TelemetryConfig } from "../TelemetryConfig.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import type { NodeObservabilityConfigEnabled, SentryConfig } from "./ObservabilityConfig.ts";
import {
  AdapterCapability,
  LifecycleStage,
  type ObservabilityProfile,
} from "./ObservabilityProfile.ts";
import type { OtlpExporter } from "effect/unstable/observability";

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
};

export type ObservabilityAdapterContext = {
  readonly profile: ObservabilityProfile;
  readonly identity: ResourceIdentity;
  readonly telemetryConfig: TelemetryConfig;
  readonly contract: ContractRegistry;
  readonly policy: DataPolicy;
  readonly sentry: SentryConfig;
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>;
};

export type ObservabilityAdapterHandle = {
  readonly flush: Effect.Effect<void, AdapterFailure>;
  readonly close: Effect.Effect<void, AdapterFailure>;
};

export type ObservabilityAdapter = {
  readonly name: AdapterName;
  readonly capability: AdapterCapability;
  readonly stage: LifecycleStage;
  readonly start: (
    context: ObservabilityAdapterContext,
  ) => Effect.Effect<ObservabilityAdapterHandle, AdapterFailure>;
};

export class OfficialAdapterRegistration {
  readonly #officialRegistration = true;
  readonly kind = "official";
  constructor(readonly adapter: ObservabilityAdapter) {}
  registrationBrand(): boolean {
    return this.#officialRegistration;
  }
}

export class TestingAdapterRegistration {
  readonly #testingRegistration = true;
  readonly kind = "testing";
  constructor(readonly adapter: ObservabilityAdapter) {}
  registrationBrand(): boolean {
    return this.#testingRegistration;
  }
}

export type AdapterRegistration = OfficialAdapterRegistration | TestingAdapterRegistration;

export const registerOfficialAdapter = (
  adapter: ObservabilityAdapter,
): OfficialAdapterRegistration => new OfficialAdapterRegistration(adapter);

export const registerTestingAdapter = (adapter: ObservabilityAdapter): TestingAdapterRegistration =>
  new TestingAdapterRegistration(adapter);

export type AdapterOutcomeResult =
  | { readonly kind: "completed"; readonly durationMillis: number }
  | { readonly kind: "failed"; readonly error: AdapterFailure }
  | { readonly kind: "deadline-exceeded"; readonly budgetMillis: number }
  | { readonly kind: "skipped"; readonly reason: "deadline-exhausted" };

export type AdapterOutcome = {
  readonly adapter: AdapterName;
  readonly capability: AdapterCapability;
  readonly stage: LifecycleStage;
  readonly result: AdapterOutcomeResult;
};

export type LifecycleReport = {
  readonly operation: "flush" | "close";
  readonly outcomes: ReadonlyArray<AdapterOutcome>;
  readonly durationMillis: number;
  readonly degraded: boolean;
};

export type StartedAdapter = {
  readonly registration: AdapterRegistration;
  readonly handle: ObservabilityAdapterHandle;
};

export type AdapterValidationInput = {
  readonly config: NodeObservabilityConfigEnabled;
  readonly registrations: ReadonlyArray<AdapterRegistration>;
};
