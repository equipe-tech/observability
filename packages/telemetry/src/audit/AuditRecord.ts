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
  Schema.Struct({ kind: Schema.Literal("user"), id: boundedIdentifier }),
  Schema.Struct({ kind: Schema.Literal("service"), id: boundedIdentifier }),
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

const decodeSchemaVersion = Schema.decodeUnknownEffect(Schema.Literal(1));
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
  const action = contract.auditActionByName.get(input.action);
  if (action === undefined) {
    return yield* invalid(
      "OBS_AUDIT_UNKNOWN_ACTION",
      `Audit action "${input.action}" is not declared by the telemetry contract. Use a declared action.`,
      "action",
      input.action,
    );
  }
  const recordId = yield* decodeRecordId(input.recordId).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_FIELD",
        "Audit record ID is invalid. Use 1 to 128 characters without control characters.",
        "recordId",
        input.action,
      ),
    ),
  );
  const actor = yield* decodeActor(input.actor).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_ACTOR",
        "Audit actor is invalid. Use a bounded user or service snapshot, or the system actor.",
        "actor",
        input.action,
      ),
    ),
  );
  const resourceId = yield* decodeResourceId(input.resource.id).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_RESOURCE",
        "Audit resource ID is invalid. Use 1 to 128 characters without control characters.",
        "resource.id",
        input.action,
      ),
    ),
  );
  const resourceType = yield* decodeResourceType(action.resourceType).pipe(Effect.orDie);
  const outcome = yield* decodeOutcome(input.outcome).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_OUTCOME",
        "Audit outcome is invalid. Use success, failure, cancelled, or denied.",
        "outcome",
        input.action,
      ),
    ),
  );
  if (!action.allowedOutcomes.includes(outcome)) {
    return yield* invalid(
      "OBS_AUDIT_INVALID_OUTCOME",
      `Audit action "${input.action}" does not allow outcome "${outcome}". Use a declared outcome.`,
      "outcome",
      input.action,
    );
  }
  const rawReasonCode = optionalString(input.reasonCode);
  const reasonCode = yield* Option.match(rawReasonCode, {
    onNone: () => Effect.succeed(Option.none<AuditReasonCode>()),
    onSome: (value) =>
      decodeReasonCode(value).pipe(
        Effect.flatMap((parsed) =>
          action.reasonCodes.includes(parsed)
            ? Effect.succeed(Option.some(parsed))
            : invalid(
                "OBS_AUDIT_UNKNOWN_REASON_CODE",
                `Audit reason code "${value}" is not declared for action "${input.action}". Use a declared reason code or omit it.`,
                "reasonCode",
                input.action,
              ),
        ),
        Effect.mapError(() =>
          invalid(
            "OBS_AUDIT_UNKNOWN_REASON_CODE",
            "Audit reason code is invalid. Use a declared dotted lowercase code, not free text.",
            "reasonCode",
            input.action,
          ),
        ),
      ),
  });
  const rawTenantId = optionalString(input.tenantId);
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
            input.action,
          ),
        ),
      ),
  });
  const occurredAt = yield* decodeOccurredAt(input.occurredAt).pipe(
    Effect.mapError(() =>
      invalid(
        "OBS_AUDIT_INVALID_FIELD",
        "Audit occurrence time is invalid. Use an RFC 3339 UTC timestamp.",
        "occurredAt",
        input.action,
      ),
    ),
  );
  const correlation =
    input.correlation === undefined
      ? yield* CurrentCorrelation
      : yield* decodeCorrelation(input.correlation).pipe(
          Effect.mapError(() =>
            invalid(
              "OBS_AUDIT_INVALID_FIELD",
              "Audit correlation is invalid. Use a canonical traced or untraced correlation context.",
              "correlation",
              input.action,
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
