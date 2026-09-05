import { Clock, Context, DateTime, Effect, Option, Schema } from "effect";
import { auditCommitDocumentFor, type AuditCommitDocument } from "./AuditCommitDocument.ts";
import { AuditDigest, canonicalAuditPayload } from "./AuditDigest.ts";
import {
  sealCommittedAuditRecord,
  type CommittedAuditRecord,
} from "./CommittedAuditRecordInternal.ts";
import { AuditOccurredAt, reparseAuditRecord, type AuditRecord } from "./AuditRecord.ts";
import { InvalidAuditRecord } from "./InvalidAuditRecord.ts";

export type { CommittedAuditRecord } from "./CommittedAuditRecordInternal.ts";

export type AuditDropReason =
  | "unbound"
  | "closed"
  | "queue-overflow"
  | "contract-rejected"
  | "policy-rejected"
  | "transport";

export type AuditPublishReceipt =
  | { readonly kind: "published" }
  | { readonly kind: "deduplicated" }
  | { readonly kind: "dropped"; readonly reason: AuditDropReason };

export type AuditPublishReasonCounts = {
  readonly unbound: number;
  readonly closed: number;
  readonly queueOverflow: number;
  readonly contractRejected: number;
  readonly policyRejected: number;
  readonly transport: number;
};

export type AuditPublishReport = {
  readonly published: number;
  readonly deduplicated: number;
  readonly dropped: number;
  readonly firstDroppedAt: Option.Option<string>;
  readonly lastDroppedAt: Option.Option<string>;
  readonly reasons: AuditPublishReasonCounts;
};

const emptyReport = (): AuditPublishReport => ({
  published: 0,
  deduplicated: 0,
  dropped: 0,
  firstDroppedAt: Option.none(),
  lastDroppedAt: Option.none(),
  reasons: {
    unbound: 0,
    closed: 0,
    queueOverflow: 0,
    contractRejected: 0,
    policyRejected: 0,
    transport: 0,
  },
});

export type AuditPublisherService = {
  readonly publish: (record: CommittedAuditRecord) => Effect.Effect<AuditPublishReceipt>;
  readonly report: () => AuditPublishReport;
};

export const unboundAuditPublisher = (): AuditPublisherService => {
  let drops = 0;
  let firstDrop = Option.none<string>();
  let lastDrop = Option.none<string>();
  return {
    publish: () =>
      Effect.gen(function* () {
        const droppedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        drops += 1;
        if (Option.isNone(firstDrop)) firstDrop = Option.some(droppedAt);
        lastDrop = Option.some(droppedAt);
        return { kind: "dropped", reason: "unbound" };
      }),
    report: () => ({
      ...emptyReport(),
      dropped: drops,
      firstDroppedAt: firstDrop,
      lastDroppedAt: lastDrop,
      reasons: { ...emptyReport().reasons, unbound: drops },
    }),
  };
};

export class AuditPublisher extends Context.Service<AuditPublisher, AuditPublisherService>()(
  "@equipe-tech/observability/AuditPublisher",
) {}

export type CommitAuditResult<A> = {
  readonly committed: A;
  readonly record: CommittedAuditRecord;
};

export const commitAuditRecord = <A, E, R>(
  record: AuditRecord,
  durableWrite: (document: AuditCommitDocument) => Effect.Effect<A, E, R>,
): Effect.Effect<CommitAuditResult<A>, E | InvalidAuditRecord, R | AuditDigest> =>
  Effect.gen(function* () {
    const reparsed = yield* reparseAuditRecord(record);
    const committedAt = Schema.decodeUnknownSync(AuditOccurredAt)(
      DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    );
    const digest = yield* AuditDigest;
    const ledgerHash = yield* digest.hash(canonicalAuditPayload(reparsed, committedAt));
    const document = auditCommitDocumentFor(reparsed, committedAt, ledgerHash);
    const committed = yield* durableWrite(document);
    const committedRecord = sealCommittedAuditRecord(reparsed, committedAt, ledgerHash);
    return { committed, record: committedRecord };
  });

export type RecordAuditResult<A> = CommitAuditResult<A> & {
  readonly publish: AuditPublishReceipt;
};

export const recordAudit = <A, E, R>(
  record: AuditRecord,
  durableWrite: (document: AuditCommitDocument) => Effect.Effect<A, E, R>,
): Effect.Effect<RecordAuditResult<A>, E | InvalidAuditRecord, R | AuditDigest | AuditPublisher> =>
  Effect.gen(function* () {
    const result = yield* commitAuditRecord(record, durableWrite);
    const publisher = yield* AuditPublisher;
    const publish = yield* publisher.publish(result.record);
    return { ...result, publish };
  });
