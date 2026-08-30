import { ConfigProvider, Duration, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient, HttpClientRequest } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization } from "effect/unstable/observability";
import type { InvalidResourceIdentity } from "./ResourceIdentity.ts";
import type { DuplicateReleaseVariable } from "./profile/ObservabilityConfigError.ts";
import { layerPolicyOtlpLogger } from "./PolicyOtlpLogger.ts";
import { instanceResourceAttributes } from "./ResourceIdentity.ts";
import type { EnvironmentVariables, InvalidTelemetryEnvironment } from "./TelemetryConfig.ts";
import { telemetryConfigFromEnv, type TelemetryConfig } from "./TelemetryConfig.ts";
import { layerMetricsRuntime } from "./MetricsRuntime.ts";
import { layerHttpServerOtlpTracer } from "./nestjs/HttpServerOtlpTracer.ts";
import { baseDataPolicy, CurrentDataPolicy, type DataPolicy } from "./policy/DataPolicy.ts";
import {
  parseResourceAttributes,
  type ResourceAttribute,
} from "./policy/ResourceAttributePolicy.ts";

const packageResourceConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({}));

export type OtlpLayerOptions = {
  readonly shutdownTimeout?: Duration.Input | undefined;
  readonly policy?: DataPolicy | undefined;
  readonly resourceAttributes?: ReadonlyArray<ResourceAttribute> | undefined;
};

export const layerOtlp = (
  config: TelemetryConfig,
  options: OtlpLayerOptions = {},
): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
  const policy = options.policy ?? baseDataPolicy;
  const canonical = instanceResourceAttributes(config.identity, config.environmentAlias);
  return Layer.unwrap(
    Effect.map(
      Effect.orDie(parseResourceAttributes(policy, canonical, options.resourceAttributes ?? [])),
      (parsed) => {
        const base = HttpClientRequest.get(config.otlpEndpoint.toString());
        const url = (path: string): string => HttpClientRequest.appendUrl(base, path).url;
        const resource = {
          serviceName: config.identity.serviceName,
          serviceVersion: config.identity.serviceVersion,
          attributes: Object.fromEntries(parsed),
        };
        const metrics = layerMetricsRuntime(config, {
          shutdownTimeoutMilliseconds: Duration.toMillis(options.shutdownTimeout ?? "3 seconds"),
          policy,
        });
        return Layer.mergeAll(
          Layer.succeed(CurrentDataPolicy, policy),
          layerPolicyOtlpLogger({
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
        ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(packageResourceConfig));
      },
    ),
  );
};

export const layer = (
  config: TelemetryConfig,
  options: OtlpLayerOptions = {},
): Layer.Layer<OtlpExporter.Flusher> =>
  layerOtlp(config, options).pipe(Layer.provide(FetchHttpClient.layer));

export const layerFromEnv = (
  env: EnvironmentVariables,
  options: OtlpLayerOptions = {},
): Layer.Layer<
  OtlpExporter.Flusher,
  InvalidTelemetryEnvironment | InvalidResourceIdentity | DuplicateReleaseVariable
> => Layer.unwrap(Effect.map(telemetryConfigFromEnv(env), (config) => layer(config, options)));
