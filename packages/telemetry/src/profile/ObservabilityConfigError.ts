import { Schema } from "effect";

export const ObservabilityConfigField = Schema.Literals([
  "profile",
  "adapters",
  "contract",
  "policy",
  "policy.blockedKeys",
  "policy.blockedValuePatterns",
  "OTEL_SERVICE_NAME",
  "OTEL_SERVICE_VERSION",
  "OTEL_DEPLOYMENT_ENVIRONMENT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "SENTRY_DSN",
]);
export type ObservabilityConfigField = typeof ObservabilityConfigField.Type;

export class InvalidObservabilityConfig extends Schema.TaggedError<InvalidObservabilityConfig>()(
  "InvalidObservabilityConfig",
  {
    code: Schema.Literals([
      "OBS_OBSERVABILITY_CONFIG_INVALID",
      "OBS_OBSERVABILITY_PROFILE_UNSUPPORTED_RUNTIME",
      "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
      "OBS_OBSERVABILITY_ADAPTER_MISSING",
      "OBS_OBSERVABILITY_ADAPTER_DUPLICATE",
    ]),
    message: Schema.String,
    field: ObservabilityConfigField,
    rule: Schema.String,
    cause: Schema.Defect().pipe(Schema.optionalKey),
  },
) {}

export const SecondReleaseVariable = Schema.Literals(["SENTRY_RELEASE", "OTEL_SERVICE_RELEASE"]);
export type SecondReleaseVariable = typeof SecondReleaseVariable.Type;

export const secondReleaseVariables: ReadonlyArray<SecondReleaseVariable> = [
  "SENTRY_RELEASE",
  "OTEL_SERVICE_RELEASE",
];

export class DuplicateReleaseVariable extends Schema.TaggedError<DuplicateReleaseVariable>()(
  "DuplicateReleaseVariable",
  {
    code: Schema.Literal("OBS_TELEMETRY_DUPLICATE_RELEASE_VARIABLE"),
    message: Schema.String,
    variable: SecondReleaseVariable,
  },
) {}
