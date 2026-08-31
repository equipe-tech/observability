import type { AuditHash } from "./AuditDigest.ts";
import type { AuditOccurredAt, AuditRecord } from "./AuditRecord.ts";

const committedAuditRecordBrand: unique symbol = Symbol("CommittedAuditRecord");

export type CommittedAuditRecord = AuditRecord & {
  readonly committedAt: AuditOccurredAt;
  readonly ledgerHash: AuditHash;
  readonly [committedAuditRecordBrand]: true;
};

export const sealCommittedAuditRecord = (
  record: AuditRecord,
  committedAt: AuditOccurredAt,
  ledgerHash: AuditHash,
): CommittedAuditRecord => {
  const committed: CommittedAuditRecord = {
    ...record,
    committedAt,
    ledgerHash,
    [committedAuditRecordBrand]: true,
  };
  return Object.freeze(committed);
};
