import { Effect, Exit, Option, Schema } from "effect";
import { parseResourceIdentity } from "../../ResourceIdentity.ts";
import {
  contractIndex,
  defineTelemetryContract,
  telemetryContractProvenance,
  type EmitReceipt,
  type TelemetryContract,
} from "../../contract/index.ts";
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
import type {
  AuditPublishReceipt,
  CommitAuditResult,
  CommittedAuditRecord,
} from "../../audit/AuditPublisher.ts";
import { isCommittedAuditRecord } from "../../audit/CommittedAuditRecordInternal.ts";
import type { CapturedTelemetry } from "../index.ts";
import {
  ConformanceViolation,
  defineConformanceEvidenceProvider,
  type ConformanceEvidenceProvider,
  type ConformanceCheckId,
  type ConformanceTargetBinding,
} from "./ConformanceModel.ts";

export const conformanceTargetBinding = <Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  identity: ConformanceTargetBinding["identity"],
): ConformanceTargetBinding => ({
  identity,
  contract: contractIndex(contract, identity.serviceName),
  producerContractProvenance: telemetryContractProvenance(contract),
});

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
        if (
          input.service.name !== target.binding.identity.serviceName ||
          input.service.version !== target.binding.identity.serviceVersion ||
          input.service.environment !== target.binding.identity.environment
        ) {
          return yield* Effect.fail(
            violation(
              "The profile service identity differs from the target binding.",
              `${input.service.name}@${input.service.version}:${input.service.environment}`,
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
    verify: (target) =>
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
        if (
          identity.serviceName !== target.binding.identity.serviceName ||
          identity.serviceVersion !== target.binding.identity.serviceVersion ||
          identity.environment !== target.binding.identity.environment
        ) {
          return yield* Effect.fail(
            violation(
              "The resource identity receipt differs from the target binding. Use the same service name, version, and environment for every provider.",
              `${identity.serviceName}@${identity.serviceVersion}:${identity.environment}`,
            ),
          );
        }
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
    verify: (target) =>
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
        const index = contractIndex(compiled.value, target.binding.identity.serviceName);
        if (
          JSON.stringify(index) !== JSON.stringify(target.binding.contract) ||
          telemetryContractProvenance(compiled.value) !== target.binding.producerContractProvenance
        ) {
          return yield* Effect.fail(
            violation(
              "The compiled telemetry contract differs from the target contract binding. Derive every provider from the same compiled contract.",
              `contract v${input.contract.version}`,
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
    verify: (target) =>
      Effect.gen(function* () {
        const eventName =
          input.receipt.decision === "sampled_out" ? input.receipt.name : input.receipt.event.name;
        if (
          input.receipt.contractProvenance !== target.binding.producerContractProvenance ||
          !target.binding.contract.events.some((event) => event.name === eventName)
        ) {
          return yield* Effect.fail(
            violation(
              "The producer receipt does not originate from the complete target contract binding or name one of its events.",
              eventName,
            ),
          );
        }
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
        const disposed = input.report.outcomes.some(
          (outcome) =>
            outcome.participant === "runtime-disposal" && outcome.result.kind === "completed",
        );
        if (input.report.operation !== "close" || !disposed) {
          return yield* Effect.fail(
            violation(
              "Shutdown compliance requires a close receipt with completed runtime disposal. Close the runtime before submitting lifecycle evidence.",
              input.report.operation,
            ),
          );
        }
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
  readonly operationalRecordId?: string | undefined;
  readonly operationalRecord?: CommittedAuditRecord | undefined;
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
        if (
          !isCommittedAuditRecord(input.commit.record) ||
          input.commit.record !== input.operationalRecord ||
          input.commit.record.action !== input.operationalAction ||
          input.commit.record.recordId !== input.operationalRecordId
        ) {
          return yield* Effect.fail(
            violation(
              "The durable receipt does not identify the complete requested operational audit record and action. Supply the same owner-produced committed record to both paths.",
              `${input.operationalRecordId ?? "missing record"}:${input.operationalAction ?? "missing action"}`,
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

export type TelemetryDestinationReceipt = {
  readonly topology: "local" | "deployed";
  readonly assessment: "owner-readback" | "application-supplied-readback";
  readonly runId: string;
  readonly identity: ConformanceTargetBinding["identity"];
  readonly observationId: string;
};

type TelemetryDestinationAssessment = {
  readonly topology: "local" | "deployed";
  readonly runId: string;
  readonly identity: ConformanceTargetBinding["identity"];
  readonly observationId: string;
  readonly readback: () => CapturedTelemetry;
};

const cloneOption = <Value>(value: Option.Option<Value>): Option.Option<Value> =>
  Option.isSome(value) ? Option.some(value.value) : Option.none();

const cloneCapturedTelemetry = (telemetry: CapturedTelemetry): CapturedTelemetry => ({
  spans: telemetry.spans.map((span) => ({
    ...span,
    parentSpanId: cloneOption(span.parentSpanId),
    statusMessage: cloneOption(span.statusMessage),
    attributes: new Map(span.attributes),
    events: span.events.map((event) => ({ ...event, attributes: new Map(event.attributes) })),
    links: span.links.map((link) => ({ ...link, attributes: new Map(link.attributes) })),
    eventNames: [...span.eventNames],
    linkedSpanIds: [...span.linkedSpanIds],
    resourceAttributes: new Map(span.resourceAttributes),
  })),
  logs: telemetry.logs.map((log) => ({
    ...log,
    traceId: cloneOption(log.traceId),
    spanId: cloneOption(log.spanId),
    severityText: cloneOption(log.severityText),
    body: cloneOption(log.body),
    attributes: new Map(log.attributes),
    resourceAttributes: new Map(log.resourceAttributes),
  })),
  metrics: telemetry.metrics.map((metric) => {
    const common = {
      ...metric,
      points: metric.points.map((point) => ({
        ...point,
        value: cloneOption(point.value),
        attributes: new Map(point.attributes),
      })),
      resourceAttributes: new Map(metric.resourceAttributes),
    };
    if (common.kind !== "histogram") return common;
    return {
      ...common,
      histogramPoints: common.histogramPoints.map((point) => ({
        ...point,
        attributes: new Map(point.attributes),
        explicitBounds: [...point.explicitBounds],
        bucketCounts: [...point.bucketCounts],
      })),
    };
  }),
});

const destinationReceipts = new WeakMap<TelemetryDestinationReceipt, CapturedTelemetry>();

export const assessTelemetryDestination = (
  assessment: TelemetryDestinationAssessment,
): TelemetryDestinationReceipt => {
  const receipt = Object.freeze({
    topology: assessment.topology,
    assessment:
      assessment.topology === "local" ? "owner-readback" : "application-supplied-readback",
    runId: assessment.runId,
    identity: Object.freeze({
      serviceName: assessment.identity.serviceName,
      serviceVersion: assessment.identity.serviceVersion,
      environment: assessment.identity.environment,
    }),
    observationId: assessment.observationId,
  } as const);
  destinationReceipts.set(receipt, cloneCapturedTelemetry(assessment.readback()));
  return receipt;
};

export const applicationDeployedTelemetryDestinationReceipt = (assessment: {
  readonly runId: string;
  readonly identity: ConformanceTargetBinding["identity"];
  readonly observationId: string;
  readonly readback: () => CapturedTelemetry;
}): TelemetryDestinationReceipt =>
  assessTelemetryDestination({ ...assessment, topology: "deployed" });

export const telemetryDestinationTelemetry = (
  receipt: TelemetryDestinationReceipt,
): CapturedTelemetry | undefined => {
  const telemetry = destinationReceipts.get(receipt);
  return telemetry === undefined ? undefined : cloneCapturedTelemetry(telemetry);
};

export const telemetryDestinationMatches = (
  receipt: TelemetryDestinationReceipt,
  topology: "local" | "deployed",
  runId: string,
  binding: ConformanceTargetBinding,
): boolean =>
  destinationReceipts.has(receipt) &&
  receipt.topology === topology &&
  receipt.runId === runId &&
  receipt.identity.serviceName === binding.identity.serviceName &&
  receipt.identity.serviceVersion === binding.identity.serviceVersion &&
  receipt.identity.environment === binding.identity.environment;

const traceGraphIsAcyclic = (spans: CapturedTelemetry["spans"]): boolean => {
  const spanById = new Map<string, CapturedTelemetry["spans"][number]>();
  for (const span of spans) {
    if (spanById.has(span.spanId)) return false;
    spanById.set(span.spanId, span);
  }
  for (const span of spans) {
    const visited = new Set<string>();
    let current: CapturedTelemetry["spans"][number] | undefined = span;
    while (current !== undefined) {
      if (visited.has(current.spanId)) return false;
      visited.add(current.spanId);
      current = Option.isSome(current.parentSpanId)
        ? spanById.get(current.parentSpanId.value)
        : undefined;
    }
  }
  return true;
};

const matchesIdentity = (
  attributes: CapturedTelemetry["logs"][number]["resourceAttributes"],
  binding: ConformanceTargetBinding,
): boolean =>
  attributes.get("service.name") === binding.identity.serviceName &&
  attributes.get("service.version") === binding.identity.serviceVersion &&
  attributes.get("deployment.environment.name") === binding.identity.environment;

export const telemetryCanaryConformance = (input: {
  readonly runId: string;
  readonly receipt: TelemetryDestinationReceipt;
  readonly metricRunIdAttribute?: string | undefined;
}): ConformanceProvider<"canary.telemetry-destination"> =>
  defineConformanceEvidenceProvider({
    id: "canary.telemetry-destination",
    owner: "telemetry",
    verify: (target) =>
      Effect.gen(function* () {
        const receipt = input.receipt;
        const telemetry = telemetryDestinationTelemetry(receipt);
        if (
          telemetry === undefined ||
          !telemetryDestinationMatches(receipt, target.topology, input.runId, target.binding)
        ) {
          return yield* Effect.fail(
            violation(
              "The telemetry canary lacks a Collector or destination read-back receipt bound to the current topology, run, and resource identity.",
              receipt?.observationId ?? "exporter capture",
            ),
          );
        }
        const logs = telemetry.logs.filter(
          (log) =>
            log.attributes.get("run.id") === receipt.runId &&
            matchesIdentity(log.resourceAttributes, target.binding) &&
            target.binding.contract.events.some(
              (event) => event.name === log.attributes.get("event.name"),
            ),
        );
        const currentTraceIds = new Set(
          logs.flatMap((log) => (Option.isSome(log.traceId) ? [log.traceId.value] : [])),
        );
        const spans = telemetry.spans.filter(
          (span) =>
            currentTraceIds.has(span.traceId) &&
            matchesIdentity(span.resourceAttributes, target.binding),
        );
        const metricRunIdAttribute = input.metricRunIdAttribute;
        const metrics = telemetry.metrics.filter(
          (metric) =>
            matchesIdentity(metric.resourceAttributes, target.binding) &&
            target.binding.contract.metrics.some(
              (entry) =>
                entry.name === metric.name &&
                metricRunIdAttribute !== undefined &&
                entry.attributes.includes(metricRunIdAttribute),
            ) &&
            metricRunIdAttribute !== undefined &&
            metric.points.some(
              (point) => point.attributes.get(metricRunIdAttribute) === receipt.runId,
            ),
        );
        const linked = logs.some((log) => {
          if (Option.isNone(log.traceId) || Option.isNone(log.spanId)) return false;
          const traceId = log.traceId.value;
          const spanId = log.spanId.value;
          const linkedSpan = spans.find(
            (span) => span.traceId === traceId && span.spanId === spanId,
          );
          if (linkedSpan === undefined) return false;
          return spans.some((child) => {
            if (child.traceId !== traceId || Option.isNone(child.parentSpanId)) return false;
            const parentSpanId = child.parentSpanId.value;
            return spans.some(
              (parent) =>
                parent.traceId === traceId &&
                parent.spanId === parentSpanId &&
                parent.spanId !== child.spanId,
            );
          });
        });
        if (
          logs.length === 0 ||
          (target.capabilities.traces &&
            (spans.length === 0 || !linked || !traceGraphIsAcyclic(spans))) ||
          (target.capabilities.metrics && metrics.length === 0)
        ) {
          return yield* Effect.fail(
            violation(
              "The telemetry canary lacks current-run contract events, selected signals, canonical resources, or trace parentage.",
              receipt.runId,
            ),
          );
        }
        return {
          owner: "telemetry",
          receiptType: "telemetry-canary",
          receiptId: receipt.observationId,
          summary: `captured current-run telemetry with ${logs.length} events, ${spans.length} spans, and ${metrics.length} metrics`,
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
