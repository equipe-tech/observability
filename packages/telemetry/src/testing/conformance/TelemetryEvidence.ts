import { Effect, Exit, Option, Schema } from "effect";
import { parseResourceIdentity } from "../../ResourceIdentity.ts";
import { defineTelemetryContract, type EmitReceipt } from "../../contract/index.ts";
import type { TelemetryContractInput } from "../../contract/TelemetryContract.ts";

type StaticEventNames<Definition extends TelemetryContractInput> = {
  readonly events: {
    readonly [
      Alias in keyof Definition["events"]
    ]: string extends Definition["events"][Alias]["name"] ? never : Definition["events"][Alias];
  };
};
import { CorrelationContext } from "../../Correlation.ts";
import { parseDataPolicy } from "../../policy/DataPolicy.ts";
import type { DataPolicyInput } from "../../policy/DataPolicy.ts";
import { observabilityProfiles, type ProfileName } from "../../profile/ObservabilityProfile.ts";
import type { LifecycleReport } from "../../profile/ObservabilityAdapter.ts";
import type { AuditPublishReceipt, CommitAuditResult } from "../../audit/AuditPublisher.ts";
import type { CapturedTelemetry } from "../index.ts";
import {
  ConformanceViolation,
  defineConformanceEvidenceProvider,
  type ConformanceEvidenceProvider,
  type ConformanceCheckId,
} from "./ConformanceModel.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

const officialProfile = (profile: ProfileName): boolean =>
  observabilityProfiles[profile] !== undefined;

export const profileConformance = (input: {
  readonly profile: ProfileName;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly environment: string;
  };
}): ConformanceProvider<"profile.official"> =>
  defineConformanceEvidenceProvider({
    id: "profile.official",
    owner: "telemetry",
    verify: (target) =>
      Effect.gen(function* () {
        if (!officialProfile(input.profile)) {
          return yield* Effect.fail(
            violation(
              `Profile "${input.profile}" is not one of the five official profiles. Select nestjs-api, worker, react-web, cli, or library.`,
              input.profile,
            ),
          );
        }
        if (target.profile.name !== input.profile) {
          return yield* Effect.fail(
            violation(
              `The evidence profile ${input.profile} differs from target profile ${target.profile.name}. Use one profile for the complete conformance target.`,
              `${input.profile} != ${target.profile.name}`,
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "profile-descriptor",
          receiptId: input.profile,
          summary: `official profile ${input.profile} for ${input.service.name}`,
        } as const;
      }),
  });

export const identityConformance = (input: {
  readonly identity: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly environment: string;
    readonly instance?: Option.Option<string> | undefined;
  };
}): ConformanceProvider<"identity.canonical"> =>
  defineConformanceEvidenceProvider({
    id: "identity.canonical",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        const identity = yield* parseResourceIdentity(input.identity).pipe(
          Effect.mapError((cause): ConformanceViolation =>
            violation(
              `The canonical resource identity is invalid: ${cause.message}`,
              `${cause.field}=${cause.value}`,
              cause,
            ),
          ),
        );
        return {
          owner: "telemetry",
          receiptType: "resource-identity",
          receiptId: identity.serviceName,
          summary: `canonical identity ${identity.serviceName}@${identity.serviceVersion} in ${identity.environment}`,
        } as const;
      }),
  });

export const contractConformance = <
  Definition extends TelemetryContractInput & StaticEventNames<Definition>,
>(input: {
  readonly contract: Definition;
}): ConformanceProvider<"contract.compiles"> =>
  defineConformanceEvidenceProvider({
    id: "contract.compiles",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        const compiled = yield* Effect.exit(defineTelemetryContract(input.contract));
        if (!Exit.isSuccess(compiled)) {
          return yield* Effect.fail(
            violation(
              "The telemetry contract does not compile. Fix every reported contract issue.",
              "telemetry contract input",
              compiled.cause,
            ),
          );
        }
        const eventCount = Object.keys(input.contract.events).length;
        const metricCount = Object.keys(input.contract.metrics).length;
        return {
          owner: "telemetry",
          receiptType: "telemetry-contract",
          receiptId: `v${input.contract.version}`,
          summary: `contract compiled with ${eventCount} events and ${metricCount} metrics`,
        } as const;
      }),
  });

export const producersConformance = (input: {
  readonly receipt: EmitReceipt;
}): ConformanceProvider<"producers.contract-derived"> =>
  defineConformanceEvidenceProvider({
    id: "producers.contract-derived",
    owner: "telemetry",
    verify: () =>
      Effect.sync(() => {
        if (input.receipt.decision === "sampled_out") {
          return {
            owner: "telemetry",
            receiptType: "emit-receipt",
            receiptId: input.receipt.name,
            summary: "producer derived from the contract returned a sampled_out receipt",
          } as const;
        }
        return {
          owner: "telemetry",
          receiptType: "emit-receipt",
          receiptId: input.receipt.event.name,
          summary: `recorded emit with ${input.receipt.redactions.length} policy redactions`,
        } as const;
      }),
  });

export const correlationConformance = (input: {
  readonly correlation: CorrelationContext;
}): ConformanceProvider<"correlation.canonical"> =>
  defineConformanceEvidenceProvider({
    id: "correlation.canonical",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        const valid = Schema.is(CorrelationContext)(input.correlation);
        if (!valid) {
          return yield* Effect.fail(
            violation(
              "The correlation context is not a canonical CorrelationContext. Use the typed correlation parsers.",
              "correlation context",
            ),
          );
        }
        const linkage = input.correlation.trace;
        const correlationId =
          linkage._tag === "Traced"
            ? linkage.traceId
            : (Option.getOrUndefined(input.correlation.runId) ??
              Option.getOrUndefined(input.correlation.requestId) ??
              "untraced");
        return {
          owner: "telemetry",
          receiptType: "correlation-context",
          receiptId: correlationId,
          summary: `canonical correlation with ${linkage._tag} trace linkage`,
        } as const;
      }),
  });

export const policyConformance = (input: {
  readonly policy: DataPolicyInput;
}): ConformanceProvider<"policy.compiles"> =>
  defineConformanceEvidenceProvider({
    id: "policy.compiles",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        const policy = yield* parseDataPolicy(input.policy).pipe(
          Effect.mapError((cause): ConformanceViolation =>
            violation(
              "The data policy does not compile. Fix every reported policy issue.",
              "data policy input",
              cause,
            ),
          ),
        );
        return {
          owner: "telemetry",
          receiptType: "data-policy",
          receiptId: `${policy.attributes.size}`,
          summary: `compiled data policy with ${policy.attributes.size} attribute rules`,
        } as const;
      }),
  });

const failedOutcomes = (report: LifecycleReport): ReadonlyArray<string> =>
  report.outcomes
    .filter(
      (outcome) => outcome.result.kind === "failed" || outcome.result.kind === "deadline-exceeded",
    )
    .map((outcome) =>
      outcome.participant === "adapter"
        ? `${outcome.adapter}:${outcome.result.kind}`
        : `runtime-disposal:${outcome.result.kind}`,
    );

export const lifecycleConformance = (input: {
  readonly report: LifecycleReport;
}): ConformanceProvider<"lifecycle.profile-compliant"> =>
  defineConformanceEvidenceProvider({
    id: "lifecycle.profile-compliant",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        const failed = failedOutcomes(input.report);
        if (input.report.degraded || failed.length > 0) {
          return yield* Effect.fail(
            violation(
              `The lifecycle report is ${input.report.degraded ? "degraded" : "failed"} for outcomes ${failed.join(", ")}. Close the runtime within the profile deadline.`,
              failed.join(",") || "degraded lifecycle report",
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "lifecycle-report",
          receiptId: input.report.operation,
          summary: `lifecycle ${input.report.operation} completed in ${input.report.durationMillis}ms`,
        } as const;
      }),
  });

export const libraryLifecycleConformance = (input: {
  readonly runtimeMarkers: ReadonlyArray<string>;
}): ConformanceProvider<"lifecycle.profile-compliant"> =>
  defineConformanceEvidenceProvider({
    id: "lifecycle.profile-compliant",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        if (input.runtimeMarkers.length > 0) {
          return yield* Effect.fail(
            violation(
              `The library profile forbids a global runtime, adapters, exporters, Sentry clients, and browser ingest. Found ${input.runtimeMarkers.join(", ")}.`,
              input.runtimeMarkers.join(","),
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "runtime-absence",
          receiptId: "library",
          summary:
            "no global runtime, adapter, exporter, Sentry client, or browser ingest installed",
        } as const;
      }),
  });

export const auditConformance = (input: {
  readonly commit?: CommitAuditResult<unknown> | undefined;
  readonly operationalAction?: string | undefined;
}): ConformanceProvider<"audit.durable-before-operational"> =>
  defineConformanceEvidenceProvider({
    id: "audit.durable-before-operational",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        if (input.commit === undefined) {
          return yield* Effect.fail(
            violation(
              `The audit action ${input.operationalAction ?? "unknown"} has no durable commit receipt. Call recordAudit with a durable ledger write before the operational copy.`,
              `audit action ${input.operationalAction ?? "unknown"} has no durable commit receipt`,
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "commit-audit-result",
          receiptId: input.commit.record.recordId,
          summary: "durable ledger receipt precedes the operational audit copy",
        } as const;
      }),
  });

export const telemetryCanaryConformance = (input: {
  readonly runId: string;
  readonly telemetry: CapturedTelemetry;
}): ConformanceProvider<"canary.telemetry-destination"> =>
  defineConformanceEvidenceProvider({
    id: "canary.telemetry-destination",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        const tracedSpans = input.telemetry.spans.filter(
          (span) => span.traceId !== "" && span.spanId !== "",
        );
        const logTraceIds = new Set(
          input.telemetry.logs.flatMap((log) =>
            Option.isSome(log.traceId) ? [log.traceId.value] : [],
          ),
        );
        const correlated = tracedSpans.filter((span) => logTraceIds.has(span.traceId));
        if (correlated.length === 0) {
          return yield* Effect.fail(
            violation(
              "The telemetry canary did not capture correlated spans and events through the Collector pipeline. Run the local pipeline canary for an exported signal.",
              input.runId,
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "telemetry-canary",
          receiptId: input.runId,
          summary: `captured ${correlated.length} spans correlated with exported events through the Collector pipeline`,
        } as const;
      }),
  });

export const auditCanaryConformance = (input: {
  readonly ledgerReceiptId: string;
  readonly publish: AuditPublishReceipt;
}): ConformanceProvider<"canary.audit"> =>
  defineConformanceEvidenceProvider({
    id: "canary.audit",
    owner: "telemetry",
    verify: () =>
      Effect.gen(function* () {
        if (input.publish.kind === "dropped") {
          return yield* Effect.fail(
            violation(
              "The audit canary dropped the operational copy. Keep the durable ledger write before publication and retry the canary.",
              `audit publish dropped: ${input.publish.reason}`,
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "audit-canary",
          receiptId: input.ledgerReceiptId,
          summary: `audit canary ${input.publish.kind} with durable ledger receipt`,
        } as const;
      }),
  });
