import { Effect, Option, Schema } from "effect";
import {
  EnvironmentAliasPolicy,
  InvalidResourceIdentity,
  parseResourceIdentity,
  ResourceIdentity,
} from "./ResourceIdentity.ts";
import type { DuplicateReleaseVariable } from "./profile/ObservabilityConfigError.ts";
import {
  deploymentScopeFromEndpoint,
  rejectSecondReleaseVariables,
} from "./profile/EnvironmentPolicy.ts";

export const OtlpEndpoint = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "",
    { expected: "an HTTP or HTTPS URL without credentials" },
  ),
);

export interface TelemetryConfigInput {
  readonly identity: ResourceIdentity;
  readonly environmentAlias?: EnvironmentAliasPolicy | undefined;
  readonly otlpEndpoint: URL;
}

export class TelemetryConfig extends Schema.Class<TelemetryConfig>(
  "@equipe-tech/observability/TelemetryConfig",
)({
  identity: ResourceIdentity,
  environmentAlias: EnvironmentAliasPolicy.pipe(
    Schema.withConstructorDefault(Effect.succeed("omitted")),
  ),
  otlpEndpoint: OtlpEndpoint,
}) {
  constructor(input: TelemetryConfigInput) {
    super({
      identity: input.identity,
      environmentAlias: input.environmentAlias ?? "omitted",
      otlpEndpoint: input.otlpEndpoint,
    });
  }
}

export class InvalidTelemetryEnvironment extends Schema.TaggedError<InvalidTelemetryEnvironment>()(
  "InvalidTelemetryEnvironment",
  {
    code: Schema.Literal("OBS_TELEMETRY_INVALID_ENVIRONMENT"),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const TelemetryEnvironment = Schema.Struct({
  OTEL_SERVICE_NAME: Schema.NonEmptyString,
  OTEL_SERVICE_VERSION: Schema.NonEmptyString.pipe(Schema.optionalKey),
  OTEL_DEPLOYMENT_ENVIRONMENT: Schema.NonEmptyString.pipe(Schema.optionalKey),
  OTEL_SERVICE_INSTANCE_ID: Schema.Union([Schema.String, Schema.Undefined]).pipe(
    Schema.optionalKey,
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: OtlpEndpoint.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://localhost:4318")),
  ),
});

export type EnvironmentVariables = {
  readonly [name: string]: string | undefined;
};

const decodeTelemetryEnvironment = Schema.decodeUnknownEffect(TelemetryEnvironment);

export const telemetryConfigFromEnv = Effect.fn("telemetryConfigFromEnv")(function* (
  env: EnvironmentVariables,
): Effect.fn.Return<
  TelemetryConfig,
  InvalidTelemetryEnvironment | InvalidResourceIdentity | DuplicateReleaseVariable
> {
  yield* rejectSecondReleaseVariables(env);
  const variables = yield* decodeTelemetryEnvironment(env).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidTelemetryEnvironment({
          code: "OBS_TELEMETRY_INVALID_ENVIRONMENT",
          message:
            "Telemetry environment is invalid. Set OTEL_SERVICE_NAME and use valid values for the remaining OTEL variables.",
          cause,
        }),
    ),
  );
  const local = deploymentScopeFromEndpoint(variables.OTEL_EXPORTER_OTLP_ENDPOINT) === "local";
  const serviceVersion = variables.OTEL_SERVICE_VERSION ?? (local ? "0.0.0" : undefined);
  const environment = variables.OTEL_DEPLOYMENT_ENVIRONMENT ?? (local ? "development" : undefined);
  if (serviceVersion === undefined || environment === undefined) {
    return yield* new InvalidTelemetryEnvironment({
      code: "OBS_TELEMETRY_INVALID_ENVIRONMENT",
      message:
        "A remote OTLP endpoint requires OTEL_SERVICE_VERSION and OTEL_DEPLOYMENT_ENVIRONMENT. Set both canonical identity variables.",
      cause: "remote identity is incomplete",
    });
  }
  const identity = yield* parseResourceIdentity({
    serviceName: variables.OTEL_SERVICE_NAME,
    serviceVersion,
    environment,
    instance:
      variables.OTEL_SERVICE_INSTANCE_ID === ""
        ? Option.none()
        : Option.fromNullishOr(variables.OTEL_SERVICE_INSTANCE_ID),
  });
  return new TelemetryConfig({
    identity,
    otlpEndpoint: variables.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
});
