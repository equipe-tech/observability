export { conformanceChecks } from "./ConformanceRegistry.ts";
export type { ConformanceCheck } from "./ConformanceRegistry.ts";
export {
  ConformanceAssertionError,
  ConformanceFailure,
  InvalidConformanceSuite,
  conformanceFailureCodes,
} from "./ConformanceFailure.ts";
export type { ConformanceFailureCode } from "./ConformanceFailure.ts";
export {
  assertConformanceFailure,
  assertConforms,
} from "./ConformanceAssertions.ts";
export { runConformance, runConformanceSuite } from "./ConformanceRunner.ts";
export { defineConformanceEvidenceProvider } from "./ConformanceModel.ts";
export type {
  ConformanceCapabilitySelection,
  ConformanceCheckId,
  ConformanceEvidence,
  ConformanceEvidenceProvider,
  ConformanceFail,
  ConformanceNotApplicable,
  ConformanceOwner,
  ConformancePass,
  ConformanceProfileReport,
  ConformanceReport,
  ConformanceResult,
  ConformanceTarget,
  ConformanceTargetContext,
  ConformanceTopology,
  ConformanceViolation,
  SourceRuleReference,
} from "./ConformanceModel.ts";
export {
  auditCanaryConformance,
  auditConformance,
  contractConformance,
  correlationConformance,
  identityConformance,
  libraryLifecycleConformance,
  lifecycleConformance,
  policyConformance,
  producersConformance,
  profileConformance,
  telemetryCanaryConformance,
} from "./TelemetryEvidence.ts";
