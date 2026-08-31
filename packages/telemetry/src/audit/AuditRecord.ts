import { Effect, Option, Predicate, Schema } from "effect";
import { CorrelationContext, CurrentCorrelation } from "../Correlation.ts";
import type { TelemetryContract, TelemetryContractInput } from "../contract/TelemetryContract.ts";
import { InvalidAuditRecord } from "./InvalidAuditRecord.ts";

const isControlCharacterFree = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false;
  }
  return true;
};

const withoutControlCharacters = Schema.makeFilter(isControlCharacterFree, {
  expected: "a value without control characters",
});

const boundedIdentifier = Schema.NonEmptyString.check(
  withoutControlCharacters,
  Schema.isMaxLength(128),
);

export const AuditRecordId = boundedIdentifier.pipe(Schema.brand("AuditRecordId"));
export type AuditRecordId = typeof AuditRecordId.Type;

export const AuditTenantId = boundedIdentifier.pipe(Schema.brand("AuditTenantId"));
export type AuditTenantId = typeof AuditTenantId.Type;

export const AuditActorId = boundedIdentifier.pipe(Schema.brand("AuditActorId"));
export type AuditActorId = typeof AuditActorId.Type;

export const AuditResourceId = boundedIdentifier.pipe(Schema.brand("AuditResourceId"));
export type AuditResourceId = typeof AuditResourceId.Type;

export const AuditResourceType = Schema.NonEmptyString.check(
  withoutControlCharacters,
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/),
).pipe(Schema.brand("AuditResourceType"));
export type AuditResourceType = typeof AuditResourceType.Type;

export const AuditAction = Schema.NonEmptyString.check(
  withoutControlCharacters,
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/),
).pipe(Schema.brand("AuditAction"));
export type AuditAction = typeof AuditAction.Type;

export const AuditReasonCode = Schema.NonEmptyString.check(
  withoutControlCharacters,
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/),
).pipe(Schema.brand("AuditReasonCode"));
export type AuditReasonCode = typeof AuditReasonCode.Type;

export const AuditOutcome = Schema.Literals(["success", "failure", "cancelled", "denied"]);
export type AuditOutcome = typeof AuditOutcome.Type;

export const AuditActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), id: AuditActorId }),
  Schema.Struct({ kind: Schema.Literal("service"), id: AuditActorId }),
  Schema.Struct({ kind: Schema.Literal("system") }),
]);
export type AuditActor = typeof AuditActor.Type;
export type AuditActorInput =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "service"; readonly id: string }
  | { readonly kind: "system" };

export const AuditResource = Schema.Struct({
  type: AuditResourceType,
  id: AuditResourceId,
});
export type AuditResource = typeof AuditResource.Type;

export const AuditContext = Schema.Struct({
  action: AuditAction,
  actor: AuditActor,
  resourceType: AuditResourceType,
  resourceId: AuditResourceId,
  reasonCode: Schema.String.pipe(Schema.optionalKey),
});
export type AuditContext = typeof AuditContext.Type;

const canonicalOccurredAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const AuditOccurredAt = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      canonicalOccurredAtPattern.test(value) &&
      isControlCharacterFree(value) &&
      Date.parse(value) >= 0 &&
      new Date(value).toISOString() === value,
    { expected: "a canonical RFC 3339 UTC timestamp with millisecond precision" },
  ),
).pipe(Schema.brand("AuditOccurredAt"));
export type AuditOccurredAt = typeof AuditOccurredAt.Type;

const AuditRecordFields = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  recordId: AuditRecordId,
  action: AuditAction,
  actor: AuditActor,
  resource: AuditResource,
  outcome: AuditOutcome,
  reasonCode: Schema.Option(AuditReasonCode),
  tenantId: Schema.Option(AuditTenantId),
  occurredAt: AuditOccurredAt,
  correlation: CorrelationContext,
});
type AuditRecordFields = typeof AuditRecordFields.Type;
const parsedAuditRecordBrand: unique symbol = Symbol(
  "@equipe-tech/observability/ParsedAuditRecord",
);
export type AuditRecord = AuditRecordFields & { readonly [parsedAuditRecordBrand]: true };

export type AuditRecordInput = {
  readonly recordId: string;
  readonly action: string;
  readonly actor: AuditActorInput;
  readonly resource: { readonly id: string };
  readonly outcome: AuditOutcome;
  readonly reasonCode?: string | Option.Option<string>;
  readonly tenantId?: string | Option.Option<string>;
  readonly occurredAt: string;
  readonly correlation?: CorrelationContext;
};

const AuditRecordInputDocument = Schema.Struct({
  recordId: Schema.Any,
  action: Schema.Any,
  actor: Schema.Any,
  resource: Schema.Any,
  outcome: Schema.Any,
  reasonCode: Schema.optional(Schema.Any),
  tenantId: Schema.optional(Schema.Any),
  occurredAt: Schema.Any,
  correlation: Schema.optional(Schema.Any),
});
const AuditResourceInputDocument = Schema.Struct({ id: Schema.Any });
const AuditOptionalStringInput = Schema.Union([
  Schema.String,
  Schema.Option(Schema.String),
  Schema.Undefined,
]);

const decodeAuditRecordInput = Schema.decodeUnknownEffect(AuditRecordInputDocument);
const decodeAuditResourceInput = Schema.decodeUnknownEffect(AuditResourceInputDocument);
const decodeOptionalStringInput = Schema.decodeUnknownEffect(AuditOptionalStringInput);
const decodeSchemaVersion = Schema.decodeUnknownEffect(Schema.Literal(1));
const decodeAction = Schema.decodeUnknownEffect(AuditAction);
const decodeRecordId = Schema.decodeUnknownEffect(AuditRecordId);
const decodeActor = Schema.decodeUnknownEffect(AuditActor);
const decodeResourceId = Schema.decodeUnknownEffect(AuditResourceId);
const decodeResourceType = Schema.decodeUnknownEffect(AuditResourceType);
const decodeOutcome = Schema.decodeUnknownEffect(AuditOutcome);
const decodeReasonCode = Schema.decodeUnknownEffect(AuditReasonCode);
const decodeTenantId = Schema.decodeUnknownEffect(AuditTenantId);
const decodeOccurredAt = Schema.decodeUnknownEffect(AuditOccurredAt);
const decodeCorrelation = Schema.decodeUnknownEffect(CorrelationContext);
const decodeReasonCodeOption = Schema.decodeUnknownEffect(Schema.Option(AuditReasonCode));
const decodeTenantIdOption = Schema.decodeUnknownEffect(Schema.Option(AuditTenantId));

const invalid = (
  code: InvalidAuditRecord["code"],
  message: string,
  field: string,
  action?: string,
): InvalidAuditRecord =>
  action === undefined
    ? new InvalidAuditRecord({ code, message, field })
    : new InvalidAuditRecord({ code, message, field, action });

const optionalString = (
  value: string | Option.Option<string> | undefined,
): Option.Option<string> =>
  value === undefined ? Option.none() : Predicate.isString(value) ? Option.some(value) : value;

export const reparseAuditRecord = Effect.fn("reparseAuditRecord")(function* (
  record: AuditRecordFields,
): Effect.fn.Return<AuditRecord, InvalidAuditRecord> {
  const invalidField = (field: string): InvalidAuditRecord =>
    invalid(
      "OBS_AUDIT_INVALID_FIELD",
      `Audit record field ${field} is invalid. Parse the record before committing it.`,
      field,
    );
  const schemaVersion = yield* decodeSchemaVersion(record.schemaVersion).pipe(
    Effect.mapError(() => invalidField("schemaVersion")),
  );
  const recordId = yield* decodeRecordId(record.recordId).pipe(
    Effect.mapError(() => invalidField("recordId")),
  );
  const action = yield* Schema.decodeUnknownEffect(AuditAction)(record.action).pipe(
    Effect.mapError(() => invalidField("action")),
  );
  const actor = yield* decodeActor(record.actor).pipe(Effect.mapError(() => invalidField("actor")));
  const resource = yield* Schema.decodeUnknownEffect(AuditResource)(record.resource).pipe(
    Effect.mapError(() => invalidField("resource")),
  );
  const outcome = yield* decodeOutcome(record.outcome).pipe(
    Effect.mapError(() => invalidField("outcome")),
  );
  const reasonCode = yield* decodeReasonCodeOption(record.reasonCode).pipe(
    Effect.mapError(() => invalidField("reasonCode")),
  );
  const tenantId = yield* decodeTenantIdOption(record.tenantId).pipe(
    Effect.mapError(() => invalidField("tenantId")),
  );
  const occurredAt = yield* decodeOccurredAt(record.occurredAt).pipe(
    Effect.mapError(() => invalidField("occurredAt")),
  );
  const correlation = yield* decodeCorrelation(record.correlation).pipe(
    Effect.mapError(() => invalidField("correlation")),
  );
  const parsed: AuditRecord = {
    schemaVersion,
    recordId,
    action,
    actor: Object.freeze(actor),
    resource: Object.freeze(resource),
    outcome,
    reasonCode,
    tenantId,
    occurredAt,
    correlation,
    [parsedAuditRecordBrand]: true,
  };
  return Object.freeze(parsed);
});

export const parseAuditRecord = Effect.fn("parseAuditRecord")(function* <
  Definition extends TelemetryContractInput,
>(
  contract: TelemetryContract<Definition>,
  input: AuditRecordInput,
): Effect.fn.Return<AuditRecord, InvalidAuditRecord> {
  const document = yield* decodeAuditRecordInput(input).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_FIELD",
        "Audit record input is malformed. Provide every required audit field with its documented type.",
        "record",
      ),
    ),
  );
  const parsedAction = yield* decodeAction(document.action).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_UNKNOWN_ACTION",
        "Audit action is malformed. Use a declared dotted lowercase action up to 128 characters.",
        "action",
      ),
    ),
  );
  const action = contract.auditActionByName.get(parsedAction);
  if (action === undefined) {
    return yield* invalid(
      "OBS_AUDIT_UNKNOWN_ACTION",
      "Audit action is not declared by the telemetry contract. Use a declared action.",
      "action",
      parsedAction,
    );
  }
  const recordId = yield* decodeRecordId(document.recordId).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_FIELD",
        "Audit record ID is invalid. Use 1 to 128 characters without control characters.",
        "recordId",
        parsedAction,
      ),
    ),
  );
  const actor = yield* decodeActor(document.actor).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_ACTOR",
        "Audit actor is invalid. Use a bounded user or service snapshot, or the system actor.",
        "actor",
        parsedAction,
      ),
    ),
  );
  const resource = yield* decodeAuditResourceInput(document.resource).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_RESOURCE",
        "Audit resource is malformed. Provide an object with a bounded ID.",
        "resource",
        parsedAction,
      ),
    ),
  );
  const resourceId = yield* decodeResourceId(resource.id).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_RESOURCE",
        "Audit resource ID is invalid. Use 1 to 128 characters without control characters.",
        "resource.id",
        parsedAction,
      ),
    ),
  );
  const resourceType = yield* decodeResourceType(action.resourceType).pipe(Effect.orDie);
  const outcome = yield* decodeOutcome(document.outcome).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_OUTCOME",
        "Audit outcome is invalid. Use success, failure, cancelled, or denied.",
        "outcome",
        parsedAction,
      ),
    ),
  );
  if (!action.allowedOutcomes.includes(outcome)) {
    return yield* invalid(
      "OBS_AUDIT_INVALID_OUTCOME",
      "Audit outcome is not declared for this action. Use an allowed outcome.",
      "outcome",
      parsedAction,
    );
  }
  const reasonCodeInput = yield* decodeOptionalStringInput(document.reasonCode).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_UNKNOWN_REASON_CODE",
        "Audit reason code is malformed. Use a dotted lowercase code up to 64 characters.",
        "reasonCode",
        parsedAction,
      ),
    ),
  );
  const rawReasonCode = optionalString(reasonCodeInput);
  const reasonCode = yield* Option.match(rawReasonCode, {
    onNone: () => Effect.succeed(Option.none<AuditReasonCode>()),
    onSome: (value) =>
      Effect.gen(function* () {
        const parsed = yield* decodeReasonCode(value).pipe(
          Effect.mapError(() =>
            invalid(
              "OBS_AUDIT_UNKNOWN_REASON_CODE",
              "Audit reason code is malformed. Use a dotted lowercase code up to 64 characters.",
              "reasonCode",
              parsedAction,
            ),
          ),
        );
        if (!action.reasonCodes.includes(parsed)) {
          return yield* invalid(
            "OBS_AUDIT_UNKNOWN_REASON_CODE",
            "Audit reason code is not declared for this action. Use a declared reason code or omit it.",
            "reasonCode",
            parsedAction,
          );
        }
        return Option.some(parsed);
      }),
  });
  const tenantIdInput = yield* decodeOptionalStringInput(document.tenantId).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_FIELD",
        "Audit tenant ID is invalid. Use 1 to 128 characters without control characters.",
        "tenantId",
        parsedAction,
      ),
    ),
  );
  const rawTenantId = optionalString(tenantIdInput);
  const tenantId = yield* Option.match(rawTenantId, {
    onNone: () => Effect.succeed(Option.none<AuditTenantId>()),
    onSome: (value) =>
      decodeTenantId(value).pipe(
        Effect.map(Option.some),
        Effect.mapError(() =>
          invalid(
            "OBS_AUDIT_INVALID_FIELD",
            "Audit tenant ID is invalid. Use 1 to 128 characters without control characters.",
            "tenantId",
            parsedAction,
          ),
        ),
      ),
  });
  const occurredAt = yield* decodeOccurredAt(document.occurredAt).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_FIELD",
        "Audit occurrence time is invalid. Use an RFC 3339 UTC timestamp.",
        "occurredAt",
        parsedAction,
      ),
    ),
  );
  const correlation =
    document.correlation === undefined
      ? yield* CurrentCorrelation
      : yield* decodeCorrelation(document.correlation).pipe(
          Effect.mapError(() =>
            invalid(
              "OBS_AUDIT_INVALID_FIELD",
              "Audit correlation is invalid. Use a canonical traced or untraced correlation context.",
              "correlation",
              parsedAction,
            ),
          ),
        );
  return yield* reparseAuditRecord({
    schemaVersion: 1,
    recordId,
    action: action.action,
    actor,
    resource: { type: resourceType, id: resourceId },
    outcome,
    reasonCode,
    tenantId,
    occurredAt,
    correlation,
  });
});
