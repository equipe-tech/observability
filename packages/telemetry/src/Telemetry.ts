import { Duration, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient, HttpClientRequest } from "effect/unstable/http";
import { OtlpExporter, OtlpLogger, OtlpSerialization } from "effect/unstable/observability";
import type { EnvironmentVariables, InvalidTelemetryEnvironment } from "./TelemetryConfig.ts";
import { telemetryConfigFromEnv, type TelemetryConfig } from "./TelemetryConfig.ts";
import { layerMetricsRuntime } from "./MetricsRuntime.ts";
import { layerHttpServerOtlpTracer } from "./nestjs/HttpServerOtlpTracer.ts";

export type OtlpLayerOptions = {
  readonly shutdownTimeout?: Duration.Input | undefined;
};

export const layerOtlp = (
  config: TelemetryConfig,
  options: OtlpLayerOptions = {},
): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
  const base = HttpClientRequest.get(config.otlpEndpoint.toString());
  const url = (path: string): string => HttpClientRequest.appendUrl(base, path).url;
  const resource = {
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    attributes: {
      "deployment.environment.name": config.environment,
    },
  };
  const metrics = layerMetricsRuntime(config, {
    shutdownTimeoutMilliseconds: Duration.toMillis(options.shutdownTimeout ?? "3 seconds"),
  });
  return Layer.mergeAll(
    OtlpLogger.layer({
      url: url("/v1/logs"),
      resource,
      shutdownTimeout: options.shutdownTimeout,
    }),
    metrics,
    layerHttpServerOtlpTracer({
      url: url("/v1/traces"),
      resource,
      shutdownTimeout: options.shutdownTimeout,
    }),
  ).pipe(Layer.provide(OtlpSerialization.layerJson));
};

export const layer = (
  config: TelemetryConfig,
  options: OtlpLayerOptions = {},
): Layer.Layer<OtlpExporter.Flusher> =>
  layerOtlp(config, options).pipe(Layer.provide(FetchHttpClient.layer));

export const layerFromEnv = (
  env: EnvironmentVariables,
  options: OtlpLayerOptions = {},
): Layer.Layer<OtlpExporter.Flusher, InvalidTelemetryEnvironment> =>
  Layer.unwrap(Effect.map(telemetryConfigFromEnv(env), (config) => layer(config, options)));
