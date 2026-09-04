import { Effect, Schema } from "effect";
import {
  observabilityProfiles,
  type CapabilityRequirement,
  type ProfileName,
} from "../../profile/ObservabilityProfile.ts";
import { conformanceChecks } from "./ConformanceRegistry.ts";
import type { ConformanceCheck } from "./ConformanceRegistry.ts";
import { ConformanceFailure, InvalidConformanceSuite } from "./ConformanceFailure.ts";
import type {
  ConformanceCheckId,
  ConformanceEvidenceProvider,
  ConformanceProfileReport,
  ConformanceReport,
  ConformanceResult,
  ConformanceTarget,
  ConformanceTargetContext,
  ConformanceViolation,
} from "./ConformanceModel.ts";

const ProfileNameSchema = Schema.Literals([
  "nestjs-api",
  "worker",
  "react-web",
  "cli",
  "library",
] as const);

const decodeProfileName = Schema.decodeUnknownSync(ProfileNameSchema);

const invalidSuite = (
  code:
    | "OBS_CONFORMANCE_TARGET_INVALID"
    | "OBS_CONFORMANCE_PROVIDER_DUPLICATE"
    | "OBS_CONFORMANCE_PROVIDER_MISSING",
  message: string,
  offendingValue: string,
  cause?: unknown,
): InvalidConformanceSuite =>
  new InvalidConformanceSuite({ code, message, offendingValue, cause: cause ?? offendingValue });

const capabilitySelectionIsValid = (
  requirement: CapabilityRequirement,
  selected: boolean,
  environment: string,
): boolean => {
  if (requirement === "forbidden") return selected === false;
  if (requirement === "required") return selected;
  if (requirement === "required-in-production" && environment === "production") return selected;
  return true;
};

const validateTarget = (
  target: ConformanceTarget,
): Effect.Effect<ConformanceTargetContext, InvalidConformanceSuite> =>
  Effect.gen(function* () {
    if (target.name.trim().length === 0) {
      return yield* invalidSuite(
        "OBS_CONFORMANCE_TARGET_INVALID",
        "The conformance target name must not be empty. Name the application target.",
        target.name,
      );
    }
    const profile = yield* Effect.try({
      try: () => {
        const name = decodeProfileName(target.profile);
        return observabilityProfiles[name];
      },
      catch: (cause) =>
        invalidSuite(
          "OBS_CONFORMANCE_TARGET_INVALID",
          `The conformance target profile "${String(target.profile)}" is not one of the five official profiles.`,
          String(target.profile),
          cause,
        ),
    });
    if (target.environment.trim().length === 0) {
      return yield* invalidSuite(
        "OBS_CONFORMANCE_TARGET_INVALID",
        "The conformance target environment must not be empty. Name the deployment environment.",
        target.name,
      );
    }
    const capabilityRequirements = [
      ["traces", profile.traces, target.capabilities.traces],
      ["metrics", profile.metrics, target.capabilities.metrics],
      ["defects", profile.defects, target.capabilities.defects],
      ["browserIngest", profile.browserIngest, target.capabilities.browserIngest],
    ] as const;
    for (const [capability, requirement, selected] of capabilityRequirements) {
      if (!capabilitySelectionIsValid(requirement, selected, target.environment)) {
        return yield* invalidSuite(
          "OBS_CONFORMANCE_TARGET_INVALID",
          `The ${target.profile} profile declares ${capability} as ${requirement}, but the target selected ${selected}.`,
          `${capability}=${selected}`,
        );
      }
    }
    const providerIds = new Set<ConformanceCheckId>();
    for (const provider of target.providers) {
      if (providerIds.has(provider.id)) {
        return yield* invalidSuite(
          "OBS_CONFORMANCE_PROVIDER_DUPLICATE",
          `The conformance target declares duplicate evidence providers for ${provider.id}.`,
          provider.id,
        );
      }
      providerIds.add(provider.id);
    }
    return {
      name: target.name,
      profile,
      environment: target.environment,
      topology: target.topology,
      capabilities: target.capabilities,
    };
  });

const toFailure = (
  target: ConformanceTargetContext,
  check: ConformanceCheck,
  violation: ConformanceViolation,
): ConformanceFailure =>
  new ConformanceFailure({
    code: check.code,
    checkId: check.id,
    profile: target.profile.name,
    rule: check.rule,
    message: violation.message,
    offendingValue: violation.offendingValue,
    cause: violation.cause ?? violation.offendingValue,
  });

const runCheck = (
  target: ConformanceTargetContext,
  check: ConformanceCheck,
  providers: ReadonlyArray<ConformanceEvidenceProvider>,
): Effect.Effect<ConformanceResult, InvalidConformanceSuite> =>
  Effect.gen(function* () {
    if (!check.applies(target)) {
      return {
        status: "not-applicable",
        id: check.id,
        profile: target.profile.name,
        rule: check.rule,
        reason: check.notApplicableReason(target),
      } as const;
    }
    const provider = providers.find((candidate) => candidate.id === check.id);
    if (provider === undefined) {
      return yield* invalidSuite(
        "OBS_CONFORMANCE_PROVIDER_MISSING",
        `The applicable conformance check ${check.id} has no evidence provider. Supply the owner provider for this target.`,
        check.id,
      );
    }
    return yield* check.run(target, provider).pipe(
      Effect.match({
        onFailure: (violation) =>
          ({
            status: "fail",
            id: check.id,
            profile: target.profile.name,
            rule: check.rule,
            failure: toFailure(target, check, violation),
          }) as const,
        onSuccess: (evidence) =>
          ({
            status: "pass",
            id: check.id,
            profile: target.profile.name,
            rule: check.rule,
            evidence,
          }) as const,
      }),
    );
  });

export const runConformance = (
  target: ConformanceTarget,
): Effect.Effect<ConformanceProfileReport, InvalidConformanceSuite> =>
  Effect.gen(function* () {
    const context = yield* validateTarget(target);
    const checks: Array<ConformanceResult> = [];
    let conforms = true;
    for (const check of conformanceChecks) {
      const result = yield* runCheck(context, check, target.providers);
      if (result.status === "fail") conforms = false;
      checks.push(result);
    }
    return {
      target: target.name,
      profile: target.profile,
      conforms,
      checks,
    };
  });

export const runConformanceSuite = (
  targets: ReadonlyArray<ConformanceTarget>,
): Effect.Effect<ConformanceReport, InvalidConformanceSuite> =>
  Effect.gen(function* () {
    const seenProfiles = new Map<ProfileName, string>();
    for (const target of targets) {
      const previous = seenProfiles.get(target.profile);
      if (previous !== undefined) {
        return yield* invalidSuite(
          "OBS_CONFORMANCE_TARGET_INVALID",
          `The conformance suite declares duplicate targets for profile ${target.profile}: "${previous}" and "${target.name}".`,
          target.profile,
        );
      }
      seenProfiles.set(target.profile, target.name);
    }
    const profiles: Array<ConformanceProfileReport> = [];
    let conforms = true;
    for (const target of targets) {
      const report = yield* runConformance(target);
      if (!report.conforms) conforms = false;
      profiles.push(report);
    }
    return {
      version: 1,
      conforms,
      profiles,
    };
  });
