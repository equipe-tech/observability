import { Effect } from "effect";
import type { EnvironmentVariables } from "../TelemetryConfig.ts";
import { DuplicateReleaseVariable, secondReleaseVariables } from "./ObservabilityConfigError.ts";

export type DeploymentScope = "local" | "remote";

export const deploymentScopeFromEndpoint = (endpoint: URL): DeploymentScope =>
  endpoint.hostname === "localhost" ||
  endpoint.hostname === "[::1]" ||
  endpoint.hostname.startsWith("127.")
    ? "local"
    : "remote";

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
