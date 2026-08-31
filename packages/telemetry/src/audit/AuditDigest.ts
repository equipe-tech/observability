import { Context, Effect, Schema } from "effect";
import { Option } from "effect";
import type { AuditRecord } from "./AuditRecord.ts";

export const AuditHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("AuditHash"),
);
export type AuditHash = typeof AuditHash.Type;

export const canonicalAuditPayload = (record: AuditRecord): string =>
  JSON.stringify({
    action: record.action,
    actor:
      record.actor.kind === "system"
        ? { kind: record.actor.kind }
        : { id: record.actor.id, kind: record.actor.kind },
    correlation: {
      requestId: Option.getOrNull(record.correlation.requestId),
      runId: Option.getOrNull(record.correlation.runId),
      spanId: Option.getOrNull(record.correlation.spanId),
      traceId: Option.getOrNull(record.correlation.traceId),
    },
    occurredAt: record.occurredAt,
    outcome: record.outcome,
    reasonCode: Option.getOrNull(record.reasonCode),
    recordId: record.recordId,
    resource: { id: record.resource.id, type: record.resource.type },
    schemaVersion: record.schemaVersion,
    tenantId: Option.getOrNull(record.tenantId),
  });

export class AuditDigest extends Context.Service<
  AuditDigest,
  { readonly hash: (payload: string) => Effect.Effect<AuditHash> }
>()("@equipe-tech/observability/AuditDigest") {}
