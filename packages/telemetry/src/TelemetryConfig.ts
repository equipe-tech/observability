import { Effect, Schema } from "effect";

export class TelemetryConfig extends Schema.Class<TelemetryConfig>(
  "@equipe-tech/observability/TelemetryConfig",
)({
  serviceName: Schema.NonEmptyString,
  serviceVersion: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  otlpEndpoint: Schema.NonEmptyString,
}) {}

export class InvalidTelemetryEnvironment extends Schema.TaggedError<InvalidTelemetryEnvironment>()(
  "InvalidTelemetryEnvironment",
  {
    message: Schema.String,
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
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://localhost:4318")),
  ),
});

export type EnvironmentVariables = {
  readonly [name: string]: string | undefined;
};

const decodeTelemetryEnvironment = Schema.decodeUnknownEffect(TelemetryEnvironment);

export const telemetryConfigFromEnv = Effect.fn("telemetryConfigFromEnv")(function* (
  env: EnvironmentVariables,
): Effect.fn.Return<TelemetryConfig, InvalidTelemetryEnvironment> {
  const variables = yield* decodeTelemetryEnvironment(env).pipe(
    Effect.mapError(
      (error) =>
        new InvalidTelemetryEnvironment({
          message: `Telemetry environment is invalid: ${error.message}. Set OTEL_SERVICE_NAME and check OTEL_SERVICE_VERSION, OTEL_DEPLOYMENT_ENVIRONMENT and OTEL_EXPORTER_OTLP_ENDPOINT.`,
        }),
    ),
  );
  return new TelemetryConfig({
    serviceName: variables.OTEL_SERVICE_NAME,
    serviceVersion: variables.OTEL_SERVICE_VERSION,
    environment: variables.OTEL_DEPLOYMENT_ENVIRONMENT,
    otlpEndpoint: variables.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
});
