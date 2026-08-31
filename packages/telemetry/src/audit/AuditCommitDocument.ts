import { Option, Schema } from "effect";
import { RequestId, RunId, SpanId, TraceId } from "../Correlation.ts";
import { AuditHash } from "./AuditDigest.ts";
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

const AuditCommitCorrelation = Schema.Union([
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

export const AuditCommitDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  recordId: AuditRecordId,
  action: AuditAction,
  actor: AuditActor,
  resource: AuditResource,
  outcome: AuditOutcome,
  reasonCode: Schema.NullOr(AuditReasonCode),
  tenantId: Schema.NullOr(AuditTenantId),
  occurredAt: AuditOccurredAt,
  correlation: AuditCommitCorrelation,
  committedAt: AuditOccurredAt,
  ledgerHash: AuditHash,
});
export type AuditCommitDocument = typeof AuditCommitDocument.Type;
export type AuditCommitDocumentEncoded = typeof AuditCommitDocument.Encoded;

export const auditCommitDocumentFor = (
  record: AuditRecord,
  committedAt: AuditOccurredAt,
  ledgerHash: AuditHash,
): AuditCommitDocument => ({
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
  committedAt,
  ledgerHash,
});
