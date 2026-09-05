import { Schema, type Effect } from "effect";
import type { ContractIndex } from "../../contract/ContractIndex.ts";
import type { ObservabilityProfile, ProfileName } from "../../profile/ObservabilityProfile.ts";
import type { ConformanceFailure } from "./ConformanceFailure.ts";

export type ConformanceCheckId =
  | "profile.official"
  | "identity.canonical"
  | "contract.compiles"
  | "manifest.valid"
  | "producers.contract-derived"
  | "queries.contract-derived"
  | "correlation.canonical"
  | "policy.compiles"
  | "server-events.evlog-collector"
  | "sentry.unexpected-defects-only"
  | "lifecycle.profile-compliant"
  | "audit.durable-before-operational"
  | "pipeline.no-application-otlp"
  | "canary.telemetry-destination"
  | "canary.sentry"
  | "canary.browser-route"
  | "canary.audit";

export type SourceRuleReference = {
  readonly document: string;
  readonly heading: string;
};

export type ConformanceOwner =
  | "telemetry"
  | "cli"
  | "evlog"
  | "sentry"
  | "nestjs"
  | "react"
  | "application";

export type ConformanceTopology = "local" | "deployed";

export type ConformanceCapabilitySelection = {
  readonly traces: boolean;
  readonly metrics: boolean;
  readonly defects: boolean;
  readonly browserIngest: boolean;
  readonly audit: boolean;
};

export type ConformanceTargetBinding = {
  readonly identity: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly environment: string;
  };
  readonly contract: ContractIndex;
  readonly producerContractProvenance: string;
};

export type ConformanceTargetContext = {
  readonly name: string;
  readonly profile: ObservabilityProfile;
  readonly environment: string;
  readonly topology: ConformanceTopology;
  readonly capabilities: ConformanceCapabilitySelection;
  readonly binding: ConformanceTargetBinding;
};

export type ConformanceEvidence = {
  readonly owner: ConformanceOwner;
  readonly receiptType: string;
  readonly receiptId: string;
  readonly summary: string;
};

export class ConformanceViolation extends Schema.TaggedError<ConformanceViolation>()(
  "ConformanceViolation",
  {
    message: Schema.String,
    offendingValue: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type ConformanceEvidenceProvider<Id extends ConformanceCheckId = ConformanceCheckId> = {
  readonly id: Id;
  readonly owner: ConformanceOwner;
  readonly verify: (
    target: ConformanceTargetContext,
  ) => Effect.Effect<ConformanceEvidence, ConformanceViolation>;
};

export type ConformanceTarget = {
  readonly name: string;
  readonly profile: ProfileName;
  readonly environment: string;
  readonly topology: ConformanceTopology;
  readonly capabilities: ConformanceCapabilitySelection;
  readonly binding: ConformanceTargetBinding;
  readonly providers: ReadonlyArray<ConformanceEvidenceProvider>;
};

export type ConformancePass = {
  readonly status: "pass";
  readonly id: ConformanceCheckId;
  readonly profile: ProfileName;
  readonly rule: SourceRuleReference;
  readonly evidence: ConformanceEvidence;
};

export type ConformanceNotApplicable = {
  readonly status: "not-applicable";
  readonly id: ConformanceCheckId;
  readonly profile: ProfileName;
  readonly rule: SourceRuleReference;
  readonly reason: string;
};

export type ConformanceFail = {
  readonly status: "fail";
  readonly id: ConformanceCheckId;
  readonly profile: ProfileName;
  readonly rule: SourceRuleReference;
  readonly failure: ConformanceFailure;
};

export type ConformanceResult = ConformancePass | ConformanceFail | ConformanceNotApplicable;

export type ConformanceProfileReport = {
  readonly target: string;
  readonly profile: ProfileName;
  readonly conforms: boolean;
  readonly checks: ReadonlyArray<ConformanceResult>;
};

export type ConformanceReport = {
  readonly version: 1;
  readonly conforms: boolean;
  readonly profiles: ReadonlyArray<ConformanceProfileReport>;
};

export const defineConformanceEvidenceProvider = <Id extends ConformanceCheckId>(
  provider: ConformanceEvidenceProvider<Id>,
): ConformanceEvidenceProvider<Id> => provider;
