import { Effect, Option, Schema } from "effect";
import type { EnvironmentVariables } from "../TelemetryConfig.ts";
import { OtlpEndpoint, TelemetryConfig } from "../TelemetryConfig.ts";
import {
  EnvironmentAliasPolicy,
  type ResourceIdentity,
  parseResourceIdentity,
} from "../ResourceIdentity.ts";
import type { ContractRegistry } from "./ObservabilityAdapter.ts";
import { parseDataPolicy, type DataPolicy, type DataPolicyInput } from "./DataPolicy.ts";
import {
  DuplicateReleaseVariable,
  InvalidObservabilityConfig,
} from "./ObservabilityConfigError.ts";
import {
  deploymentScopeFromEndpoint,
  rejectSecondReleaseVariables,
  type DeploymentScope,
} from "./EnvironmentPolicy.ts";
import {
  observabilityProfiles,
  type NodeObservabilityProfile,
  type ProfileName,
  type ObservabilityProfile,
} from "./ObservabilityProfile.ts";

export type { DeploymentScope } from "./EnvironmentPolicy.ts";

export type SentryConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly dsn: URL };

export type NodeObservabilityConfigDisabled = { readonly enabled: false };

export type NodeObservabilityConfigEnabled = {
  readonly enabled: true;
  readonly profile: NodeObservabilityProfile;
  readonly deployment: DeploymentScope;
  readonly identity: ResourceIdentity;
  readonly telemetry: TelemetryConfig;
  readonly evlog: { readonly contract: ContractRegistry; readonly policy: DataPolicy };
  readonly sentry: SentryConfig;
};

export type NodeObservabilityConfig =
  | NodeObservabilityConfigDisabled
  | NodeObservabilityConfigEnabled;

export type NodeObservabilityConfigInput =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly profile: ProfileName;
      readonly service: {
        readonly name: string;
        readonly version: string;
        readonly environment: string;
        readonly instance?: string | undefined;
      };
      readonly telemetry: {
        readonly endpoint: URL;
        readonly environmentAlias?: typeof EnvironmentAliasPolicy.Type | undefined;
      };
      readonly evlog: { readonly contract: ContractRegistry; readonly policy: DataPolicyInput };
      readonly sentry: { readonly enabled: false } | { readonly enabled: true; readonly dsn: URL };
    };

export type EnvBootstrapInput = {
  readonly enabled?: boolean | undefined;
  readonly profile: ProfileName;
  readonly env: EnvironmentVariables;
  readonly contract: ContractRegistry;
  readonly policy: DataPolicyInput;
  readonly environmentAlias?: typeof EnvironmentAliasPolicy.Type | undefined;
};

const ProfileEnvironment = Schema.Struct({
  OTEL_SERVICE_NAME: Schema.NonEmptyString,
  OTEL_SERVICE_VERSION: Schema.NonEmptyString.pipe(Schema.optionalKey),
  OTEL_DEPLOYMENT_ENVIRONMENT: Schema.NonEmptyString.pipe(Schema.optionalKey),
  OTEL_SERVICE_INSTANCE_ID: Schema.String.pipe(Schema.optionalKey),
  OTEL_EXPORTER_OTLP_ENDPOINT: OtlpEndpoint.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://localhost:4318")),
  ),
  SENTRY_DSN: Schema.URLFromString.pipe(Schema.optionalKey),
});

const decodeProfileEnvironment = Schema.decodeUnknownEffect(ProfileEnvironment);

const invalid = (
  field: "profile" | "OTEL_SERVICE_VERSION" | "OTEL_DEPLOYMENT_ENVIRONMENT" | "SENTRY_DSN",
  message: string,
  rule: string,
  cause?: unknown,
): InvalidObservabilityConfig =>
  new InvalidObservabilityConfig({
    code:
      field === "profile"
        ? "OBS_OBSERVABILITY_PROFILE_UNSUPPORTED_RUNTIME"
        : "OBS_OBSERVABILITY_CONFIG_INVALID",
    field,
    message,
    rule,
    cause,
  });

const nodeProfile = (
  name: ProfileName,
): Effect.Effect<NodeObservabilityProfile, InvalidObservabilityConfig> => {
  const selected = observabilityProfiles.get(name);
  if (selected === undefined || selected.runtime !== "node-global") {
    return Effect.fail(
      invalid(
        "profile",
        `Profile "${name}" does not own a Node global runtime. Use nestjs-api, worker, or cli.`,
        "a profile that owns a Node global runtime",
      ),
    );
  }
  return Effect.succeed(selected);
};

const sentryFor = (
  profile: ObservabilityProfile,
  environment: string,
  dsn: URL | undefined,
): Effect.Effect<SentryConfig, InvalidObservabilityConfig> => {
  if (
    profile.defects === "required-in-production" &&
    environment === "production" &&
    dsn === undefined
  ) {
    return Effect.fail(
      invalid(
        "SENTRY_DSN",
        `Profile "${profile.name}" requires SENTRY_DSN in production. Set SENTRY_DSN or use a non-production environment.`,
        "a Sentry DSN URL for production",
      ),
    );
  }
  return Effect.succeed(dsn === undefined ? { enabled: false } : { enabled: true, dsn });
};

export const parseNodeObservabilityConfig = Effect.fn("parseNodeObservabilityConfig")(function* (
  input: NodeObservabilityConfigInput,
): Effect.fn.Return<NodeObservabilityConfig, InvalidObservabilityConfig> {
  if (!input.enabled) {
    return { enabled: false };
  }
  const profile = yield* nodeProfile(input.profile);
  const deployment = deploymentScopeFromEndpoint(input.telemetry.endpoint);
  const identity = yield* parseResourceIdentity({
    serviceName: input.service.name,
    serviceVersion: input.service.version,
    environment: input.service.environment,
    instance: Option.fromNullishOr(input.service.instance),
  }).pipe(
    Effect.mapError((cause) =>
      invalid(
        cause.field === "service.version" ? "OTEL_SERVICE_VERSION" : "OTEL_DEPLOYMENT_ENVIRONMENT",
        cause.message,
        cause.rule,
        cause,
      ),
    ),
  );
  const policy = yield* parseDataPolicy(input.evlog.policy);
  const sentry = yield* sentryFor(
    profile,
    input.service.environment,
    input.sentry.enabled ? input.sentry.dsn : undefined,
  );
  return {
    enabled: true,
    profile,
    deployment,
    identity,
    telemetry: new TelemetryConfig({
      identity,
      environmentAlias: input.telemetry.environmentAlias,
      otlpEndpoint: input.telemetry.endpoint,
    }),
    evlog: { contract: input.evlog.contract, policy },
    sentry,
  };
});

export const nodeObservabilityConfigFromEnv = Effect.fn("nodeObservabilityConfigFromEnv")(
  function* (
    input: EnvBootstrapInput,
  ): Effect.fn.Return<
    NodeObservabilityConfig,
    InvalidObservabilityConfig | DuplicateReleaseVariable
  > {
    if (input.enabled === false) {
      return { enabled: false };
    }
    yield* rejectSecondReleaseVariables(input.env);
    const profile = yield* nodeProfile(input.profile);
    const variables = yield* decodeProfileEnvironment(input.env).pipe(
      Effect.mapError((cause) =>
        invalid(
          "OTEL_DEPLOYMENT_ENVIRONMENT",
          "Observability environment is invalid. Set OTEL_SERVICE_NAME and valid runtime variables.",
          "valid canonical observability environment variables",
          cause,
        ),
      ),
    );
    const deployment = deploymentScopeFromEndpoint(variables.OTEL_EXPORTER_OTLP_ENDPOINT);
    const version =
      variables.OTEL_SERVICE_VERSION ?? (deployment === "local" ? "0.0.0" : undefined);
    if (version === undefined) {
      return yield* invalid(
        "OTEL_SERVICE_VERSION",
        "A remote OTLP endpoint requires OTEL_SERVICE_VERSION. Set it to the deployed release.",
        "an explicit release identity for a remote endpoint",
      );
    }
    const environment =
      variables.OTEL_DEPLOYMENT_ENVIRONMENT ?? (deployment === "local" ? "development" : undefined);
    if (environment === undefined) {
      return yield* invalid(
        "OTEL_DEPLOYMENT_ENVIRONMENT",
        "A remote OTLP endpoint requires OTEL_DEPLOYMENT_ENVIRONMENT. Set it to the deployed environment.",
        "an explicit environment for a remote endpoint",
      );
    }
    const identity = yield* parseResourceIdentity({
      serviceName: variables.OTEL_SERVICE_NAME,
      serviceVersion: version,
      environment,
      instance:
        variables.OTEL_SERVICE_INSTANCE_ID === ""
          ? Option.none()
          : Option.fromNullishOr(variables.OTEL_SERVICE_INSTANCE_ID),
    }).pipe(
      Effect.mapError((cause) =>
        invalid(
          cause.field === "service.version"
            ? "OTEL_SERVICE_VERSION"
            : "OTEL_DEPLOYMENT_ENVIRONMENT",
          cause.message,
          cause.rule,
          cause,
        ),
      ),
    );
    const policy = yield* parseDataPolicy(input.policy);
    const sentry = yield* sentryFor(profile, environment, variables.SENTRY_DSN);
    return {
      enabled: true,
      profile,
      deployment,
      identity,
      telemetry: new TelemetryConfig({
        identity,
        environmentAlias: input.environmentAlias,
        otlpEndpoint: variables.OTEL_EXPORTER_OTLP_ENDPOINT,
      }),
      evlog: { contract: input.contract, policy },
      sentry,
    };
  },
);
