import { Effect } from "effect";
import type { EnvironmentVariables } from "../TelemetryConfig.ts";
import { DuplicateReleaseVariable, secondReleaseVariables } from "./ObservabilityConfigError.ts";

export type DeploymentScope = "local" | "remote";

type EnvironmentPolicyResolution =
  | {
      readonly kind: "resolved";
      readonly endpoint: URL;
      readonly deployment: DeploymentScope;
      readonly serviceVersion: string;
      readonly environment: string;
    }
  | {
      readonly kind: "missing-remote-identity";
      readonly endpoint: URL;
      readonly deployment: "remote";
      readonly missing: "service-version" | "environment" | "service-version-and-environment";
    };

const defaultOtlpEndpoint = "http://localhost:4318";

export const deploymentScopeFromEndpoint = (endpoint: URL): DeploymentScope => {
  const hostname = endpoint.hostname;
  return hostname === "localhost" ||
    hostname === "localhost." ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
    ? "local"
    : "remote";
};

export const resolveEnvironmentPolicy = (input: {
  readonly endpoint?: URL | undefined;
  readonly serviceVersion?: string | undefined;
  readonly environment?: string | undefined;
}): EnvironmentPolicyResolution => {
  const endpoint = input.endpoint ?? new URL(defaultOtlpEndpoint);
  const deployment = deploymentScopeFromEndpoint(endpoint);
  const serviceVersion = input.serviceVersion ?? (deployment === "local" ? "0.0.0" : undefined);
  const environment = input.environment ?? (deployment === "local" ? "development" : undefined);
  if (serviceVersion !== undefined && environment !== undefined) {
    return { kind: "resolved", endpoint, deployment, serviceVersion, environment };
  }
  const missing =
    serviceVersion === undefined && environment === undefined
      ? "service-version-and-environment"
      : serviceVersion === undefined
        ? "service-version"
        : "environment";
  return { kind: "missing-remote-identity", endpoint, deployment: "remote", missing };
};

export const rejectSecondReleaseVariables = (
  env: EnvironmentVariables,
): Effect.Effect<void, DuplicateReleaseVariable> => {
  for (const variable of secondReleaseVariables) {
    const value = env[variable];
    if (value !== undefined && value !== "") {
      return Effect.fail(
        new DuplicateReleaseVariable({
          code: "OBS_TELEMETRY_DUPLICATE_RELEASE_VARIABLE",
          variable,
          message: `${variable} defines a second release identity. Remove it and set OTEL_SERVICE_VERSION.`,
        }),
      );
    }
  }
  return Effect.void;
};
