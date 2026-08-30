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
  resolveEnvironmentPolicy,
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

const decodeServiceName = Schema.decodeUnknownEffect(Schema.NonEmptyString);
const decodeServiceVersion = Schema.decodeUnknownEffect(
  Schema.Union([Schema.NonEmptyString, Schema.Undefined]),
);
const decodeDeploymentEnvironment = Schema.decodeUnknownEffect(
  Schema.Union([Schema.NonEmptyString, Schema.Undefined]),
);
const decodeServiceInstanceId = Schema.decodeUnknownEffect(
  Schema.Union([Schema.String, Schema.Undefined]),
);
const decodeOtlpEndpoint = Schema.decodeUnknownEffect(
  Schema.Union([OtlpEndpoint, Schema.Undefined]),
);
const decodeSentryDsn = Schema.decodeUnknownEffect(
  Schema.Union([Schema.URLFromString, Schema.Undefined]),
);
const decodeTelemetryConfig = Schema.decodeUnknownEffect(TelemetryConfig);

const invalid = (
  field:
    | "profile"
    | "OTEL_SERVICE_NAME"
    | "OTEL_SERVICE_VERSION"
    | "OTEL_SERVICE_INSTANCE_ID"
    | "OTEL_DEPLOYMENT_ENVIRONMENT"
    | "OTEL_EXPORTER_OTLP_ENDPOINT"
    | "SENTRY_DSN",
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
  const selected = observabilityProfiles[name];
  if (selected.runtime !== "node-global") {
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
  const identity = yield* parseResourceIdentity({
    serviceName: input.service.name,
    serviceVersion: input.service.version,
    environment: input.service.environment,
    instance: Option.fromNullishOr(input.service.instance),
  }).pipe(
    Effect.mapError((cause) =>
      invalid(
        cause.field === "service.name"
          ? "OTEL_SERVICE_NAME"
          : cause.field === "service.version"
            ? "OTEL_SERVICE_VERSION"
            : cause.field === "service.instance.id"
              ? "OTEL_SERVICE_INSTANCE_ID"
              : "OTEL_DEPLOYMENT_ENVIRONMENT",
        cause.message,
        cause.rule,
        cause,
      ),
    ),
  );
  const telemetry = yield* decodeTelemetryConfig({
    identity,
    environmentAlias: input.telemetry.environmentAlias ?? "omitted",
    otlpEndpoint: input.telemetry.endpoint.href,
  }).pipe(
    Effect.mapError((cause) =>
      invalid(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "The OTLP endpoint is invalid. Use an HTTP or HTTPS URL without credentials.",
        "an HTTP or HTTPS URL without credentials",
        cause,
      ),
    ),
  );
  const deployment = deploymentScopeFromEndpoint(telemetry.otlpEndpoint);
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
    telemetry,
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
    const serviceName = yield* decodeServiceName(input.env.OTEL_SERVICE_NAME).pipe(
      Effect.mapError((cause) =>
        invalid(
          "OTEL_SERVICE_NAME",
          "OTEL_SERVICE_NAME is invalid. Set a non-empty service name.",
          "a non-empty service name",
          cause,
        ),
      ),
    );
    const serviceVersion = yield* decodeServiceVersion(input.env.OTEL_SERVICE_VERSION).pipe(
      Effect.mapError((cause) =>
        invalid(
          "OTEL_SERVICE_VERSION",
          "OTEL_SERVICE_VERSION is invalid. Set a non-empty release identity.",
          "a non-empty release identity",
          cause,
        ),
      ),
    );
    const environment = yield* decodeDeploymentEnvironment(
      input.env.OTEL_DEPLOYMENT_ENVIRONMENT,
    ).pipe(
      Effect.mapError((cause) =>
        invalid(
          "OTEL_DEPLOYMENT_ENVIRONMENT",
          "OTEL_DEPLOYMENT_ENVIRONMENT is invalid. Set a non-empty environment name.",
          "a non-empty environment name",
          cause,
        ),
      ),
    );
    const serviceInstanceId = yield* decodeServiceInstanceId(
      input.env.OTEL_SERVICE_INSTANCE_ID,
    ).pipe(
      Effect.mapError((cause) =>
        invalid(
          "OTEL_SERVICE_INSTANCE_ID",
          "OTEL_SERVICE_INSTANCE_ID is invalid. Set a string instance identifier.",
          "a string instance identifier",
          cause,
        ),
      ),
    );
    const endpoint = yield* decodeOtlpEndpoint(input.env.OTEL_EXPORTER_OTLP_ENDPOINT).pipe(
      Effect.mapError((cause) =>
        invalid(
          "OTEL_EXPORTER_OTLP_ENDPOINT",
          "OTEL_EXPORTER_OTLP_ENDPOINT is invalid. Use an HTTP or HTTPS URL without credentials.",
          "an HTTP or HTTPS URL without credentials",
          cause,
        ),
      ),
    );
    const dsn = yield* decodeSentryDsn(input.env.SENTRY_DSN).pipe(
      Effect.mapError((cause) =>
        invalid("SENTRY_DSN", "SENTRY_DSN is invalid. Set a valid URL.", "a valid URL", cause),
      ),
    );
    const resolution = resolveEnvironmentPolicy({
      endpoint,
      serviceVersion,
      environment,
    });
    if (resolution.kind === "missing-remote-identity") {
      if (
        resolution.missing === "service-version" ||
        resolution.missing === "service-version-and-environment"
      ) {
        return yield* invalid(
          "OTEL_SERVICE_VERSION",
          "A remote OTLP endpoint requires OTEL_SERVICE_VERSION. Set it to the deployed release.",
          "an explicit release identity for a remote endpoint",
        );
      }
      return yield* invalid(
        "OTEL_DEPLOYMENT_ENVIRONMENT",
        "A remote OTLP endpoint requires OTEL_DEPLOYMENT_ENVIRONMENT. Set it to the deployed environment.",
        "an explicit environment for a remote endpoint",
      );
    }
    const identity = yield* parseResourceIdentity({
      serviceName,
      serviceVersion: resolution.serviceVersion,
      environment: resolution.environment,
      instance: serviceInstanceId === "" ? Option.none() : Option.fromNullishOr(serviceInstanceId),
    }).pipe(
      Effect.mapError((cause) =>
        invalid(
          cause.field === "service.name"
            ? "OTEL_SERVICE_NAME"
            : cause.field === "service.version"
              ? "OTEL_SERVICE_VERSION"
              : cause.field === "service.instance.id"
                ? "OTEL_SERVICE_INSTANCE_ID"
                : "OTEL_DEPLOYMENT_ENVIRONMENT",
          cause.message,
          cause.rule,
          cause,
        ),
      ),
    );
    const policy = yield* parseDataPolicy(input.policy);
    const sentry = yield* sentryFor(profile, resolution.environment, dsn);
    return {
      enabled: true,
      profile,
      deployment: resolution.deployment,
      identity,
      telemetry: new TelemetryConfig({
        identity,
        environmentAlias: input.environmentAlias,
        otlpEndpoint: resolution.endpoint,
      }),
      evlog: { contract: input.contract, policy },
      sentry,
    };
  },
);
