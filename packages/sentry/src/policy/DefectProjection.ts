import { Option, Schema } from "effect";
import type {
  CorrelationContext,
  DataPolicy,
  DefectEnvelope,
} from "@equipe-tech/observability/policy";
import { sanitizeDefectEnvelope } from "@equipe-tech/observability/policy";

export type SentryAttributeValue = string | number | boolean;

export type SentryDefectCapture = {
  readonly envelope: DefectEnvelope;
};

export type SentryCaptureOutcome =
  | { readonly kind: "captured"; readonly eventId: string }
  | { readonly kind: "deduplicated"; readonly reason: "identity" | "fingerprint" }
  | { readonly kind: "suppressed"; readonly reason: "disabled" | "policy" | "closed" }
  | { readonly kind: "failed"; readonly reason: "transport" };

export type SentryReportReasonCounts = {
  readonly disabled: number;
  readonly policy: number;
  readonly identity: number;
  readonly fingerprint: number;
  readonly captured: number;
  readonly closed: number;
  readonly transport: number;
  readonly flushIncomplete: number;
};

export type SentryDefectReport = {
  readonly total: number;
  readonly firstOutcomeAt: Option.Option<string>;
  readonly lastOutcomeAt: Option.Option<string>;
  readonly reasons: SentryReportReasonCounts;
};

export type ProjectedFrame = {
  readonly filename?: string;
  readonly function?: string;
  readonly module?: string;
};

export type ProjectedException = {
  readonly type: "UnexpectedDefect";
  readonly value: string;
  readonly stacktrace?: { readonly frames: Array<ProjectedFrame> };
};

export type ProjectedSentryEvent = {
  readonly type: undefined;
  readonly event_id: string;
  readonly timestamp: number;
  readonly level: "error";
  readonly platform: "javascript";
  readonly release: string;
  readonly environment: string;
  readonly fingerprint: Array<string>;
  readonly exception: { readonly values: Array<ProjectedException> };
  readonly tags: { readonly [name: string]: string };
  readonly contexts?: { readonly obs: { readonly [name: string]: SentryAttributeValue } };
};

export type ProjectionIdentity = {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
};

const decodeEventId = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
);

const tagsFor = (
  identity: ProjectionIdentity,
  envelope: DefectEnvelope,
): { readonly [name: string]: string } => {
  const tags: { [name: string]: string } = {
    "service.name": String(identity.serviceName),
    "service.version": String(identity.serviceVersion),
    "deployment.environment.name": String(identity.environment),
  };
  for (const [name, value] of envelope.tags) tags[name] = String(value);
  const correlation: CorrelationContext = envelope.correlation;
  if (correlation.trace._tag === "Traced") {
    tags["trace.id"] = String(correlation.trace.traceId);
    tags["span.id"] = String(correlation.trace.spanId);
  }
  if (Option.isSome(correlation.requestId))
    tags["request.id"] = String(correlation.requestId.value);
  if (Option.isSome(correlation.runId)) tags["run.id"] = String(correlation.runId.value);
  return tags;
};

const framesFor = (stack: Option.Option<string>): Array<ProjectedFrame> =>
  Option.match(stack, {
    onNone: () => [],
    onSome: (value) =>
      value
        .split("\n")
        .slice(0, 20)
        .map((line) => ({ filename: line.trim() })),
  });

export const projectDefect = (
  policy: DataPolicy,
  identity: ProjectionIdentity,
  envelope: DefectEnvelope,
  eventId: string,
): Option.Option<ProjectedSentryEvent> => {
  const decision = sanitizeDefectEnvelope(policy, envelope);
  if (Option.isNone(decision.value)) return Option.none();
  const safe = decision.value.value;
  const context: { [name: string]: SentryAttributeValue } = {};
  for (const [name, value] of safe.context) context[name] = value;
  const frames = framesFor(safe.stack);
  const exception: ProjectedException = {
    type: "UnexpectedDefect",
    value: safe.errorMessage,
  };
  if (frames.length > 0) Object.assign(exception, { stacktrace: { frames } });
  const event: ProjectedSentryEvent = {
    type: undefined,
    event_id: decodeEventId(eventId),
    timestamp: Date.now() / 1_000,
    level: "error",
    platform: "javascript",
    release: identity.serviceVersion,
    environment: identity.environment,
    fingerprint: [...safe.fingerprint],
    exception: { values: [exception] },
    tags: tagsFor(identity, safe),
  };
  if (Object.keys(context).length > 0) Object.assign(event, { contexts: { obs: context } });
  return Option.some(event);
};
