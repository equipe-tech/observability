import { Context, Effect, Exit, Option, Schema } from "effect";
import { CorrelationContext, RequestId, RunId, SpanId, TraceId } from "../Correlation.ts";
import { AuditDigest, AuditHash, canonicalAuditPayload } from "./AuditDigest.ts";
import {
  sealCommittedAuditRecord,
  type CommittedAuditRecord,
} from "./CommittedAuditRecordInternal.ts";
import {
  AuditAction,
  AuditActor,
  AuditOccurredAt,
  AuditOutcome,
  AuditReasonCode,
  AuditRecordId,
  AuditResource,
  AuditTenantId,
  type AuditRecord,
} from "./AuditRecord.ts";
import { AuditPublisher, type AuditPublishReceipt } from "./AuditPublisher.ts";

export class AuditOutboxFailure extends Schema.TaggedError<AuditOutboxFailure>()(
  "AuditOutboxFailure",
  {
    code: Schema.Literal("OBS_AUDIT_OUTBOX_FAILED"),
    message: Schema.String,
    operation: Schema.Literals(["claim", "parse", "publish", "settle"]),
    cause: Schema.Defect(),
  },
) {}

const AuditOutboxCorrelation = Schema.Union([
  Schema.Struct({
    traceId: Schema.Null,
    spanId: Schema.Null,
    requestId: Schema.NullOr(RequestId),
    runId: Schema.NullOr(RunId),
  }),
  Schema.Struct({
    traceId: TraceId,
    spanId: SpanId,
    requestId: Schema.NullOr(RequestId),
    runId: Schema.NullOr(RunId),
  }),
]);

export const AuditOutboxDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  recordId: AuditRecordId,
  action: AuditAction,
  actor: AuditActor,
  resource: AuditResource,
  outcome: AuditOutcome,
  reasonCode: Schema.NullOr(AuditReasonCode),
  tenantId: Schema.NullOr(AuditTenantId),
  occurredAt: AuditOccurredAt,
  correlation: AuditOutboxCorrelation,
  committedAt: AuditOccurredAt,
  ledgerHash: AuditHash,
});
export type AuditOutboxDocument = typeof AuditOutboxDocument.Type;

export const encodeAuditOutboxDocument = (record: CommittedAuditRecord): AuditOutboxDocument => ({
  schemaVersion: record.schemaVersion,
  recordId: record.recordId,
  action: Schema.decodeUnknownSync(AuditAction)(record.action),
  actor: record.actor,
  resource: record.resource,
  outcome: record.outcome,
  reasonCode: Option.getOrNull(record.reasonCode),
  tenantId: Option.getOrNull(record.tenantId),
  occurredAt: record.occurredAt,
  correlation:
    record.correlation.trace._tag === "Untraced"
      ? {
          traceId: null,
          spanId: null,
          requestId: Option.getOrNull(record.correlation.requestId),
          runId: Option.getOrNull(record.correlation.runId),
        }
      : {
          traceId: record.correlation.trace.traceId,
          spanId: record.correlation.trace.spanId,
          requestId: Option.getOrNull(record.correlation.requestId),
          runId: Option.getOrNull(record.correlation.runId),
        },
  committedAt: Schema.decodeUnknownSync(AuditOccurredAt)(record.committedAt),
  ledgerHash: record.ledgerHash,
});

export type AuditOutboxEntry = { readonly record: AuditOutboxDocument };

export class AuditOutbox extends Context.Service<
  AuditOutbox,
  {
    readonly claim: (
      maximum: number,
    ) => Effect.Effect<ReadonlyArray<AuditOutboxEntry>, AuditOutboxFailure>;
    readonly settle: (
      recordId: AuditRecordId,
      receipt: AuditPublishReceipt,
    ) => Effect.Effect<void, AuditOutboxFailure>;
  }
>()("@equipe-tech/observability/AuditOutbox") {}

export type AuditOutboxDrainReport = {
  readonly claimed: number;
  readonly published: number;
  readonly deduplicated: number;
  readonly dropped: number;
};

const decodeDocument = Schema.decodeUnknownEffect(AuditOutboxDocument);

const failure = (
  operation: AuditOutboxFailure["operation"],
  message: string,
  cause: AuditOutboxFailure["cause"],
): AuditOutboxFailure =>
  new AuditOutboxFailure({ code: "OBS_AUDIT_OUTBOX_FAILED", operation, message, cause });

const restore = Effect.fn("restoreAuditOutboxRecord")(function* (
  document: AuditOutboxDocument,
): Effect.fn.Return<CommittedAuditRecord, AuditOutboxFailure, AuditDigest> {
  const decoded = yield* decodeDocument(document).pipe(
    Effect.mapError((cause) =>
      failure("parse", "The claimed audit outbox document is invalid.", cause),
    ),
  );
  const correlation = new CorrelationContext({
    trace:
      decoded.correlation.traceId === null
        ? { _tag: "Untraced" }
        : {
            _tag: "Traced",
            traceId: decoded.correlation.traceId,
            spanId: decoded.correlation.spanId,
          },
    requestId:
      decoded.correlation.requestId === null
        ? Option.none()
        : Option.some(decoded.correlation.requestId),
    runId:
      decoded.correlation.runId === null ? Option.none() : Option.some(decoded.correlation.runId),
  });
  const record: AuditRecord = Object.freeze({
    schemaVersion: decoded.schemaVersion,
    recordId: decoded.recordId,
    action: decoded.action,
    actor: Object.freeze(decoded.actor),
    resource: Object.freeze(decoded.resource),
    outcome: decoded.outcome,
    reasonCode: decoded.reasonCode === null ? Option.none() : Option.some(decoded.reasonCode),
    tenantId: decoded.tenantId === null ? Option.none() : Option.some(decoded.tenantId),
    occurredAt: decoded.occurredAt,
    correlation,
  });
  const digest = yield* AuditDigest;
  const ledgerHash = yield* digest.hash(canonicalAuditPayload(record));
  if (ledgerHash !== decoded.ledgerHash) {
    return yield* failure(
      "parse",
      "The claimed audit outbox document does not match its ledger hash.",
      "ledger hash mismatch",
    );
  }
  return sealCommittedAuditRecord(record, decoded.committedAt, decoded.ledgerHash);
});

export const drainAuditOutbox = Effect.fn("drainAuditOutbox")(function* (
  maximum: number,
): Effect.fn.Return<
  AuditOutboxDrainReport,
  AuditOutboxFailure,
  AuditOutbox | AuditDigest | AuditPublisher
> {
  const outbox = yield* AuditOutbox;
  const publisher = yield* AuditPublisher;
  const entries = yield* outbox.claim(maximum);
  let published = 0;
  let deduplicated = 0;
  let dropped = 0;
  for (const entry of entries) {
    const record = yield* restore(entry.record);
    const publishExit = yield* Effect.exit(publisher.publish(record));
    if (Exit.isFailure(publishExit)) {
      return yield* failure(
        "publish",
        "The claimed audit outbox document could not be published.",
        publishExit.cause,
      );
    }
    const receipt = publishExit.value;
    yield* outbox.settle(record.recordId, receipt);
    switch (receipt.kind) {
      case "published":
        published += 1;
        break;
      case "deduplicated":
        deduplicated += 1;
        break;
      case "dropped":
        dropped += 1;
        break;
    }
  }
  return { claimed: entries.length, published, deduplicated, dropped };
});
