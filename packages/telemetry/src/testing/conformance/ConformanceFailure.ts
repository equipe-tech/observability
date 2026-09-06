import { Schema } from "effect";

export const conformanceFailureCodes = [
  "OBS_CONFORMANCE_PROFILE_INVALID",
  "OBS_CONFORMANCE_IDENTITY_INVALID",
  "OBS_CONFORMANCE_CONTRACT_INVALID",
  "OBS_CONFORMANCE_MANIFEST_INVALID",
  "OBS_CONFORMANCE_PRODUCER_INVALID",
  "OBS_CONFORMANCE_QUERY_INVALID",
  "OBS_CONFORMANCE_CORRELATION_INVALID",
  "OBS_CONFORMANCE_POLICY_INVALID",
  "OBS_CONFORMANCE_EVENT_PATH_INVALID",
  "OBS_CONFORMANCE_SENTRY_BOUNDARY_INVALID",
  "OBS_CONFORMANCE_LIFECYCLE_INVALID",
  "OBS_CONFORMANCE_AUDIT_DURABILITY_MISSING",
  "OBS_CONFORMANCE_LOCAL_OTLP_PIPELINE",
  "OBS_CONFORMANCE_TELEMETRY_CANARY_FAILED",
  "OBS_CONFORMANCE_SENTRY_CANARY_FAILED",
  "OBS_CONFORMANCE_BROWSER_CANARY_FAILED",
  "OBS_CONFORMANCE_AUDIT_CANARY_FAILED",
] as const;

export type ConformanceFailureCode = (typeof conformanceFailureCodes)[number];

export const ConformanceFailureCodeSchema = Schema.Literals(conformanceFailureCodes);

export class ConformanceFailure extends Schema.TaggedError<ConformanceFailure>()(
  "ConformanceFailure",
  {
    code: ConformanceFailureCodeSchema,
    checkId: Schema.String,
    profile: Schema.String,
    rule: Schema.Struct({
      document: Schema.String,
      heading: Schema.String,
    }),
    message: Schema.String,
    offendingValue: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class InvalidConformanceSuite extends Schema.TaggedError<InvalidConformanceSuite>()(
  "InvalidConformanceSuite",
  {
    code: Schema.Literals([
      "OBS_CONFORMANCE_TARGET_INVALID",
      "OBS_CONFORMANCE_PROVIDER_DUPLICATE",
      "OBS_CONFORMANCE_PROVIDER_MISSING",
    ]),
    message: Schema.String,
    offendingValue: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ConformanceAssertionError extends Schema.TaggedError<ConformanceAssertionError>()(
  "ConformanceAssertionError",
  {
    code: Schema.Literals([
      "OBS_CONFORMANCE_NOT_CONFORMANT",
      "OBS_CONFORMANCE_NEGATIVE_FIXTURE_PASSED",
      "OBS_CONFORMANCE_EXPECTED_FAILURE_ABSENT",
    ]),
    message: Schema.String,
    offendingValue: Schema.String,
    cause: Schema.Defect(),
  },
) {}
