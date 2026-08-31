import { Clock, Context, DateTime, Effect, Option } from "effect";
import { AuditDigest, canonicalAuditPayload, type AuditHash } from "./AuditDigest.ts";
import type { AuditRecord, AuditRecordId } from "./AuditRecord.ts";

const committedAuditRecordBrand: unique symbol = Symbol("CommittedAuditRecord");

export type CommittedAuditRecord = AuditRecord & {
  readonly committedAt: string;
  readonly ledgerHash: AuditHash;
  readonly [committedAuditRecordBrand]: true;
};

export type AuditDropReason =
  | "unbound"
  | "closed"
  | "queue-overflow"
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
  reasons: { unbound: 0, closed: 0, queueOverflow: 0, policyRejected: 0, transport: 0 },
});

export type AuditPublisherService = {
  readonly publish: (record: CommittedAuditRecord) => Effect.Effect<AuditPublishReceipt>;
  readonly report: () => AuditPublishReport;
};

let unboundDrops = 0;
let firstUnboundDrop = Option.none<string>();
let lastUnboundDrop = Option.none<string>();

export const unboundAuditPublisher: AuditPublisherService = {
  publish: () =>
    Effect.sync(() => {
      const droppedAt = new Date().toISOString();
      unboundDrops += 1;
      if (Option.isNone(firstUnboundDrop)) firstUnboundDrop = Option.some(droppedAt);
      lastUnboundDrop = Option.some(droppedAt);
      return { kind: "dropped", reason: "unbound" };
    }),
  report: () => ({
    ...emptyReport(),
    dropped: unboundDrops,
    firstDroppedAt: firstUnboundDrop,
    lastDroppedAt: lastUnboundDrop,
    reasons: { ...emptyReport().reasons, unbound: unboundDrops },
  }),
};

export const AuditPublisher = Context.Reference<AuditPublisherService>(
  "@equipe-tech/observability/AuditPublisher",
  { defaultValue: () => unboundAuditPublisher },
);

export type CommitAuditResult<A> = {
  readonly committed: A;
  readonly record: CommittedAuditRecord;
};

export const commitAuditRecord = <A, E, R>(
  record: AuditRecord,
  durableWrite: Effect.Effect<A, E, R>,
): Effect.Effect<CommitAuditResult<A>, E, R | AuditDigest> =>
  Effect.gen(function* () {
    const committed = yield* durableWrite;
    const digest = yield* AuditDigest;
    const ledgerHash = yield* digest.hash(canonicalAuditPayload(record));
    const committedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const committedRecord: CommittedAuditRecord = {
      ...record,
      committedAt,
      ledgerHash,
      [committedAuditRecordBrand]: true,
    };
    Object.freeze(committedRecord);
    return { committed, record: committedRecord };
  });

export type RecordAuditResult<A> = CommitAuditResult<A> & {
  readonly publish: AuditPublishReceipt;
};

export const recordAudit = <A, E, R>(
  record: AuditRecord,
  durableWrite: Effect.Effect<A, E, R>,
): Effect.Effect<RecordAuditResult<A>, E, R | AuditDigest> =>
  Effect.gen(function* () {
    const result = yield* commitAuditRecord(record, durableWrite);
    const publisher = yield* AuditPublisher;
    const publish = yield* publisher.publish(result.record);
    return { ...result, publish };
  });

export type AuditPublishReservation = {
  readonly recordId: AuditRecordId;
  readonly release: Effect.Effect<void>;
  readonly complete: Effect.Effect<void>;
};
