import { Effect, Option, Schema } from "effect";
import {
  EnvironmentAliasPolicy,
  InvalidResourceIdentity,
  parseResourceIdentity,
  ResourceIdentity,
} from "./ResourceIdentity.ts";

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
  OTEL_SERVICE_VERSION: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("0.0.0")),
  ),
  OTEL_DEPLOYMENT_ENVIRONMENT: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("development")),
  ),
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
): Effect.fn.Return<TelemetryConfig, InvalidTelemetryEnvironment | InvalidResourceIdentity> {
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
  const identity = yield* parseResourceIdentity({
    serviceName: variables.OTEL_SERVICE_NAME,
    serviceVersion: variables.OTEL_SERVICE_VERSION,
    environment: variables.OTEL_DEPLOYMENT_ENVIRONMENT,
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
