import { Context, Effect, Schema } from "effect";
import type { AuditRecordId } from "./AuditRecord.ts";
import {
  AuditPublisher,
  type AuditPublishReceipt,
  type CommittedAuditRecord,
} from "./AuditPublisher.ts";

export class AuditOutboxFailure extends Schema.TaggedError<AuditOutboxFailure>()(
  "AuditOutboxFailure",
  {
    code: Schema.Literal("OBS_AUDIT_OUTBOX_FAILED"),
    message: Schema.String,
    operation: Schema.Literals(["claim", "settle"]),
    cause: Schema.Defect(),
  },
) {}

export type AuditOutboxEntry = { readonly record: CommittedAuditRecord };

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

export const drainAuditOutbox = Effect.fn("drainAuditOutbox")(function* (
  maximum: number,
): Effect.fn.Return<AuditOutboxDrainReport, AuditOutboxFailure, AuditOutbox> {
  const outbox = yield* AuditOutbox;
  const publisher = yield* AuditPublisher;
  const entries = yield* outbox.claim(maximum);
  let published = 0;
  let deduplicated = 0;
  let dropped = 0;
  for (const entry of entries) {
    const receipt = yield* publisher.publish(entry.record);
    yield* outbox.settle(entry.record.recordId, receipt);
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
