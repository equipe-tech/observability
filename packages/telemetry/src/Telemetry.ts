import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Otlp } from "effect/unstable/observability";
import type { EnvironmentVariables, InvalidTelemetryEnvironment } from "./TelemetryConfig.ts";
import { telemetryConfigFromEnv, type TelemetryConfig } from "./TelemetryConfig.ts";

export const layer = (config: TelemetryConfig): Layer.Layer<never> =>
  Otlp.layerJson({
    baseUrl: config.otlpEndpoint.toString(),
    resource: {
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
      attributes: {
        "deployment.environment.name": config.environment,
      },
    },
  }).pipe(Layer.provide(FetchHttpClient.layer));

export const layerFromEnv = (
  env: EnvironmentVariables,
): Layer.Layer<never, InvalidTelemetryEnvironment> =>
  Layer.unwrap(Effect.map(telemetryConfigFromEnv(env), layer));
