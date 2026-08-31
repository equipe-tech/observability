import { Context, Effect, Exit, Option, Schema } from "effect";
import { CorrelationContext } from "../Correlation.ts";
import {
  AuditCommitDocument as AuditCommitDocumentSchema,
  auditCommitDocumentFor,
} from "./AuditCommitDocument.ts";
import { AuditDigest, canonicalAuditPayload } from "./AuditDigest.ts";
import {
  sealCommittedAuditRecord,
  type CommittedAuditRecord,
} from "./CommittedAuditRecordInternal.ts";
import type { AuditRecord } from "./AuditRecord.ts";
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

export const AuditOutboxDocument = AuditCommitDocumentSchema;
export type AuditOutboxDocument = typeof AuditOutboxDocument.Type;

export const encodeAuditOutboxDocument = (record: CommittedAuditRecord): AuditOutboxDocument =>
  auditCommitDocumentFor(record, record.committedAt, record.ledgerHash);

export const AuditOutboxClaimKey = Schema.NonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("AuditOutboxClaimKey"),
);
export type AuditOutboxClaimKey = typeof AuditOutboxClaimKey.Type;

export type AuditOutboxValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<AuditOutboxValue>
  | { readonly [field: string]: AuditOutboxValue };

export type AuditOutboxEntry = {
  readonly claimKey: AuditOutboxClaimKey;
  readonly document: AuditOutboxValue;
};

export type AuditOutboxSettlement =
  | AuditPublishReceipt
  | { readonly kind: "quarantined"; readonly reason: "invalid-document" };

export class AuditOutbox extends Context.Service<
  AuditOutbox,
  {
    readonly claim: (
      maximum: number,
    ) => Effect.Effect<ReadonlyArray<AuditOutboxEntry>, AuditOutboxFailure>;
    readonly settle: (
      claimKey: AuditOutboxClaimKey,
      settlement: AuditOutboxSettlement,
    ) => Effect.Effect<void, AuditOutboxFailure>;
  }
>()("@equipe-tech/observability/AuditOutbox") {}

export type AuditOutboxDrainReport = {
  readonly claimed: number;
  readonly published: number;
  readonly deduplicated: number;
  readonly dropped: number;
  readonly quarantined: number;
};

const decodeDocument = Schema.decodeUnknownEffect(AuditOutboxDocument);

const failure = (
  operation: AuditOutboxFailure["operation"],
  message: string,
  cause: AuditOutboxFailure["cause"],
): AuditOutboxFailure =>
  new AuditOutboxFailure({
    code: "OBS_AUDIT_OUTBOX_FAILED",
    operation,
    message,
    cause,
  });

const restore = Effect.fn("restoreAuditOutboxRecord")(function* (
  document: AuditOutboxValue,
): Effect.fn.Return<CommittedAuditRecord, AuditOutboxFailure, AuditDigest> {
  const decoded = yield* decodeDocument(document).pipe(
    Effect.mapError(() =>
      failure("parse", "The claimed audit outbox document is invalid.", "invalid document"),
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
  const ledgerHash = yield* digest.hash(canonicalAuditPayload(record, decoded.committedAt));
  if (ledgerHash !== decoded.ledgerHash) {
    return yield* failure(
      "parse",
      "The claimed audit outbox document does not match its ledger hash.",
      "digest mismatch",
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
  let quarantined = 0;
  for (const entry of entries) {
    const restored = yield* Effect.exit(restore(entry.document));
    if (Exit.isFailure(restored)) {
      yield* outbox.settle(entry.claimKey, {
        kind: "quarantined",
        reason: "invalid-document",
      });
      quarantined += 1;
      continue;
    }
    const publishExit = yield* Effect.exit(publisher.publish(restored.value));
    if (Exit.isFailure(publishExit)) {
      return yield* failure(
        "publish",
        "The claimed audit outbox document could not be published.",
        publishExit.cause,
      );
    }
    const receipt = publishExit.value;
    yield* outbox.settle(entry.claimKey, receipt);
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
  return {
    claimed: entries.length,
    published,
    deduplicated,
    dropped,
    quarantined,
  };
});
