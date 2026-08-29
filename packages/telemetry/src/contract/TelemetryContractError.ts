import { Schema } from "effect";

export const ContractIssueCode = Schema.Literals([
  "OBS_CONTRACT_INVALID_DOCUMENT",
  "OBS_CONTRACT_INVALID_VERSION",
  "OBS_CONTRACT_INVALID_EVENT_NAME",
  "OBS_CONTRACT_DUPLICATE_EVENT_NAME",
  "OBS_CONTRACT_INVALID_EVENT_KIND",
  "OBS_CONTRACT_INVALID_DEFAULT_SEVERITY",
  "OBS_CONTRACT_INVALID_ATTRIBUTE_NAME",
  "OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME",
  "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
  "OBS_CONTRACT_INVALID_SAMPLING_RATE",
  "OBS_CONTRACT_INVALID_AUDIT_ACTION",
]);

export type ContractIssueCode = typeof ContractIssueCode.Type;

export const ContractIssue = Schema.Struct({
  code: ContractIssueCode,
  message: Schema.String,
  eventAlias: Schema.String.pipe(Schema.optionalKey),
  eventName: Schema.String.pipe(Schema.optionalKey),
  attributeName: Schema.String.pipe(Schema.optionalKey),
  auditActionAlias: Schema.String.pipe(Schema.optionalKey),
});

export type ContractIssue = typeof ContractIssue.Type;

export class InvalidTelemetryContract extends Schema.TaggedError<InvalidTelemetryContract>()(
  "InvalidTelemetryContract",
  {
    code: Schema.Literal("OBS_CONTRACT_INVALID"),
    message: Schema.String,
    issues: Schema.Array(ContractIssue),
  },
) {}

export const TelemetryEventErrorCode = Schema.Literals([
  "OBS_EVENT_UNKNOWN_NAME",
  "OBS_EVENT_UNDECLARED_ATTRIBUTE",
  "OBS_EVENT_MISSING_ATTRIBUTE",
  "OBS_EVENT_INVALID_FIELD",
  "OBS_EVENT_INVALID_OUTCOME",
  "OBS_EVENT_RESTRICTED_ATTRIBUTE",
  "OBS_EVENT_UNKNOWN_AUDIT_ACTION",
  "OBS_EVENT_INVALID_AUDIT_RESOURCE",
  "OBS_EVENT_INVALID_AUDIT_OUTCOME",
]);

export type TelemetryEventErrorCode = typeof TelemetryEventErrorCode.Type;

export class InvalidTelemetryEvent extends Schema.TaggedError<InvalidTelemetryEvent>()(
  "InvalidTelemetryEvent",
  {
    code: TelemetryEventErrorCode,
    message: Schema.String,
    eventName: Schema.String.pipe(Schema.optionalKey),
    eventAlias: Schema.String.pipe(Schema.optionalKey),
    attributeName: Schema.String.pipe(Schema.optionalKey),
  },
) {}
