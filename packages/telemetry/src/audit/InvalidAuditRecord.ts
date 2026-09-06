import { Schema } from "effect";

export const AuditRecordErrorCode = Schema.Literals([
  "OBS_AUDIT_UNKNOWN_ACTION",
  "OBS_AUDIT_INVALID_ACTOR",
  "OBS_AUDIT_INVALID_RESOURCE",
  "OBS_AUDIT_INVALID_OUTCOME",
  "OBS_AUDIT_UNKNOWN_REASON_CODE",
  "OBS_AUDIT_INVALID_FIELD",
]);
export type AuditRecordErrorCode = typeof AuditRecordErrorCode.Type;

export class InvalidAuditRecord extends Schema.TaggedError<InvalidAuditRecord>()(
  "InvalidAuditRecord",
  {
    code: AuditRecordErrorCode,
    message: Schema.String,
    field: Schema.String,
    action: Schema.String.pipe(Schema.optionalKey),
  },
) {}
