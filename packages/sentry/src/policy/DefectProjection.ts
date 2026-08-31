import { Option, Schema } from "effect";
import type { CorrelationContext, DataPolicy } from "@equipe-tech/observability/policy";
import { DefectEnvelope, sanitizeDefectEnvelope } from "@equipe-tech/observability/policy";
import { SentryAdapterError } from "../SentryAdapterError.ts";

export type SentryAttributeValue = string | number | boolean;

export const SentryDefectCapture = Schema.Struct({ envelope: DefectEnvelope });
export type SentryDefectCapture = typeof SentryDefectCapture.Type;

const decodeCapture = Schema.decodeUnknownSync(SentryDefectCapture);
const isCapture = Schema.is(SentryDefectCapture);

export const parseSentryDefectCapture = (input: SentryDefectCapture): SentryDefectCapture => {
  try {
    return isCapture(input) ? input : decodeCapture(input);
  } catch (cause) {
    throw new SentryAdapterError({
      code: "OBS_SENTRY_CAPTURE_INVALID",
      message: "The Sentry defect capture is invalid. Use unexpectedDefect to build it.",
      cause,
    });
  }
};

export type SentryVerificationReceipt = {
  readonly eventId: string;
  readonly flushed: true;
};

export type SentryCaptureOutcome =
  | { readonly kind: "queued"; readonly eventId: string }
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
  readonly abs_path?: string;
  readonly function?: string;
  readonly module?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app?: boolean;
};

export type PublicStackParser = (stack: string) => Array<ProjectedFrame>;

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
  const tags: { [name: string]: string } = {};
  for (const [name, value] of envelope.tags) tags[name] = String(value);
  tags["service.name"] = String(identity.serviceName);
  tags["service.version"] = String(identity.serviceVersion);
  tags["deployment.environment.name"] = String(identity.environment);
  tags["error.code"] = String(envelope.fingerprint[0] ?? envelope.errorType);
  delete tags["trace.id"];
  delete tags["span.id"];
  delete tags["request.id"];
  delete tags["run.id"];
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

const framesFor = (
  stack: Option.Option<string>,
  stackParser: PublicStackParser,
): Array<ProjectedFrame> =>
  Option.match(stack, {
    onNone: () => [],
    onSome: (value) =>
      stackParser(value)
        .slice(-20)
        .map((frame) =>
          frame.filename === undefined ? { ...frame } : { ...frame, abs_path: frame.filename },
        ),
  });

export const projectDefect = (
  policy: DataPolicy,
  identity: ProjectionIdentity,
  envelope: DefectEnvelope,
  eventId: string,
  stackParser: PublicStackParser,
): Option.Option<ProjectedSentryEvent> => {
  const decision = sanitizeDefectEnvelope(policy, envelope);
  if (Option.isNone(decision.value)) return Option.none();
  const safe = decision.value.value;
  const context: { [name: string]: SentryAttributeValue } = {};
  for (const [name, value] of safe.context) context[name] = value;
  const frames = framesFor(safe.stack, stackParser);
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
    release: identity.serviceVersion,
    environment: identity.environment,
    fingerprint: [...safe.fingerprint],
    exception: { values: [exception] },
    tags: tagsFor(identity, safe),
  };
  if (Object.keys(context).length > 0) Object.assign(event, { contexts: { obs: context } });
  return Option.some(event);
};

const projectFinalException = (exception: ProjectedException): ProjectedException => {
  const projected: ProjectedException = {
    type: exception.type,
    value: exception.value,
  };
  if (exception.stacktrace !== undefined) {
    Object.assign(projected, {
      stacktrace: { frames: exception.stacktrace.frames.map((frame) => ({ ...frame })) },
    });
  }
  return projected;
};

export const projectFinalEvent = (event: ProjectedSentryEvent): ProjectedSentryEvent => {
  const projected: ProjectedSentryEvent = {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    release: event.release,
    environment: event.environment,
    fingerprint: [...event.fingerprint],
    exception: { values: event.exception.values.map(projectFinalException) },
    tags: { ...event.tags },
  };
  if (event.contexts !== undefined) {
    Object.assign(projected, { contexts: { obs: { ...event.contexts.obs } } });
  }
  return projected;
};
