import { Clock, Context, DateTime, Effect, Option, Predicate, Random, Schema } from "effect";
import {
  type AttributeDefinitionsInput,
  type AuditActionDefinitionInput,
  type CompiledEventDefinition,
  type TelemetryContract,
  type TelemetryContractInput,
} from "./TelemetryContract.ts";
import {
  AuditContext,
  type AuditActor,
  type AttributeValue,
  type CorrelationContext,
  ErrorContext,
  EventDuration,
  type EventAttributes,
  EventOutcome,
  EventSeverity,
  EventTimestamp,
  HttpContext,
  type TelemetryEvent,
  isValidAttributeValue,
} from "./TelemetryEvent.ts";
import { InvalidTelemetryEvent } from "./TelemetryContractError.ts";

export class TelemetryEventSink extends Context.Service<
  TelemetryEventSink,
  { readonly record: (event: TelemetryEvent) => Effect.Effect<void> }
>()("@equipe-tech/observability/TelemetryEventSink") {}

type RequiredAttributeNames<Attributes extends AttributeDefinitionsInput> = {
  readonly [Name in keyof Attributes]: Attributes[Name]["required"] extends true ? Name : never;
}[keyof Attributes];

type EventAttributesOf<Attributes extends AttributeDefinitionsInput> = {
  readonly [Name in RequiredAttributeNames<Attributes>]: AttributeValue;
} & {
  readonly [Name in Exclude<keyof Attributes, RequiredAttributeNames<Attributes>>]?: AttributeValue;
};

type EventPayloadBase<Attributes extends AttributeDefinitionsInput> = {
  readonly timestamp?: string;
  readonly severity?: EventSeverity;
  readonly correlation?: Option.Option<CorrelationContext>;
  readonly attributes: EventAttributesOf<Attributes>;
};

type AuditPayloadForAction<Action extends AuditActionDefinitionInput> = {
  readonly outcome: Action["allowedOutcomes"][number];
  readonly audit: {
    readonly action: Action["action"];
    readonly actor: AuditActor;
    readonly resourceType: Action["resourceType"];
    readonly resourceId: string;
  };
};

type AuditPayload<Definition extends TelemetryContractInput> = {
  readonly [Alias in keyof Definition["auditActions"]]: AuditPayloadForAction<
    Definition["auditActions"][Alias]
  >;
}[keyof Definition["auditActions"]];

type EventPayloadForKind<
  Kind,
  Attributes extends AttributeDefinitionsInput,
  Definition extends TelemetryContractInput,
> = Kind extends "request"
  ? EventPayloadBase<Attributes> & {
      readonly outcome: EventOutcome;
      readonly durationMs: number;
      readonly http: HttpContext;
    }
  : Kind extends "operation"
    ? EventPayloadBase<Attributes> & {
        readonly outcome: EventOutcome;
        readonly durationMs: number;
      }
    : Kind extends "domain"
      ? EventPayloadBase<Attributes> & { readonly outcome: EventOutcome }
      : Kind extends "defect"
        ? EventPayloadBase<Attributes> & {
            readonly outcome?: never;
            readonly error: ErrorContext;
          }
        : Kind extends "audit"
          ? EventPayloadBase<Attributes> & AuditPayload<Definition>
          : never;

export type EventPayloadOf<
  Definition extends TelemetryContractInput,
  Alias extends keyof Definition["events"] & string,
> = EventPayloadForKind<
  Definition["events"][Alias]["kind"],
  Definition["events"][Alias]["attributes"],
  Definition
>;

export type EmitReceipt =
  | { readonly decision: "recorded"; readonly event: TelemetryEvent }
  | { readonly decision: "sampled_out"; readonly name: string };

export type EventProducer<Definition extends TelemetryContractInput> = {
  readonly emit: <Alias extends keyof Definition["events"] & string>(
    alias: Alias,
    payload: EventPayloadOf<Definition, Alias>,
  ) => Effect.Effect<EmitReceipt, InvalidTelemetryEvent, TelemetryEventSink>;
};

const eventError = (
  code: InvalidTelemetryEvent["code"],
  message: string,
  context: {
    readonly eventName?: string;
    readonly eventAlias?: string;
    readonly attributeName?: string;
  },
): InvalidTelemetryEvent => new InvalidTelemetryEvent({ code, message, ...context });

type EmittedAttributes = {
  readonly [attributeName: string]: AttributeValue | undefined;
};

const parseAttributes = (
  definition: CompiledEventDefinition,
  attributes: EmittedAttributes,
): InvalidTelemetryEvent | EventAttributes => {
  if (!Predicate.isObject(attributes)) {
    return eventError(
      "OBS_EVENT_INVALID_FIELD",
      `Event "${definition.name}" has invalid attributes. Use a declared scalar attribute object.`,
      { eventName: definition.name, attributeName: "attributes" },
    );
  }
  for (const attributeName of definition.requiredAttributes) {
    if (!Object.hasOwn(attributes, attributeName)) {
      return eventError(
        "OBS_EVENT_MISSING_ATTRIBUTE",
        `Event "${definition.name}" is missing required attribute "${attributeName}". Add the declared scalar attribute before emitting.`,
        { eventName: definition.name, attributeName },
      );
    }
  }
  const parsed: { [attributeName: string]: AttributeValue } = {};
  for (const [attributeName, value] of Object.entries(attributes)) {
    const attribute = definition.attributes.get(attributeName);
    if (attribute === undefined) {
      return eventError(
        "OBS_EVENT_UNDECLARED_ATTRIBUTE",
        `Event "${definition.name}" does not declare attribute "${attributeName}". Add it to the contract or remove it from the event.`,
        { eventName: definition.name, attributeName },
      );
    }
    if (value === undefined || !isValidAttributeValue(value)) {
      return eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${definition.name}" has a non-scalar or non-finite value for "${attributeName}". Use a string, finite number, or boolean.`,
        { eventName: definition.name, attributeName },
      );
    }
    if (attribute.classification === "sensitive" || attribute.classification === "forbidden") {
      return eventError(
        "OBS_EVENT_RESTRICTED_ATTRIBUTE",
        `Event "${definition.name}" cannot emit restricted attribute "${attributeName}". Remove it until OBS-47 supplies a policy transform.`,
        { eventName: definition.name, attributeName },
      );
    }
    parsed[attributeName] = value;
  }
  return parsed;
};

const decodeSeverity = Schema.decodeUnknownEffect(EventSeverity);
const decodeOutcome = Schema.decodeUnknownEffect(EventOutcome);
const decodeTimestamp = Schema.decodeUnknownEffect(EventTimestamp);
const decodeDuration = Schema.decodeUnknownEffect(EventDuration);
const decodeHttp = Schema.decodeUnknownEffect(HttpContext);
const decodeError = Schema.decodeUnknownEffect(ErrorContext);
const decodeAudit = Schema.decodeUnknownEffect(AuditContext);

const parseTimestamp = (eventName: string, timestamp: string) =>
  decodeTimestamp(timestamp).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has an invalid timestamp. Use a real RFC 3339 UTC timestamp ending in Z.`,
        { eventName, attributeName: "event.timestamp" },
      ),
    ),
  );

const parseDuration = (eventName: string, durationMs: number) =>
  decodeDuration(durationMs).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has an invalid durationMs. Use a finite non-negative number.`,
        { eventName, attributeName: "event.duration_ms" },
      ),
    ),
  );

const parseHttp = (eventName: string, http: HttpContext) =>
  decodeHttp(http).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has invalid HTTP context. Use a non-empty method and route with an integer status code from 100 to 599.`,
        { eventName, attributeName: "http" },
      ),
    ),
  );

const parseError = (eventName: string, error: ErrorContext) =>
  decodeError(error).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has invalid error context. Use a non-empty type, a message, and a boolean retryable value.`,
        { eventName, attributeName: "error" },
      ),
    ),
  );

const parseAudit = (eventName: string, audit: AuditContext) =>
  decodeAudit(audit).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has invalid audit context. Use a declared action, actor, resource type, and resource id.`,
        { eventName, attributeName: "audit" },
      ),
    ),
  );

const parseCorrelation = (
  eventName: string,
  correlation: Option.Option<CorrelationContext> | undefined,
): Effect.Effect<Option.Option<CorrelationContext>, InvalidTelemetryEvent> => {
  if (correlation === undefined) {
    return Effect.succeed(Option.none());
  }
  const value =
    Option.isOption(correlation) && Option.isSome(correlation) ? correlation.value : null;
  const requestId = Predicate.isObject(value) ? value.requestId : undefined;
  const runId = Predicate.isObject(value) ? value.runId : undefined;
  const requestIdIsValid =
    Option.isOption(requestId) &&
    (Option.isNone(requestId) ||
      (Predicate.isString(requestId.value) && requestId.value.length > 0));
  const runIdIsValid =
    Option.isOption(runId) &&
    (Option.isNone(runId) || (Predicate.isString(runId.value) && runId.value.length > 0));
  if (
    !Option.isOption(correlation) ||
    (Option.isSome(correlation) && (!requestIdIsValid || !runIdIsValid))
  ) {
    return Effect.fail(
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has invalid correlation context. Use non-empty optional request and run identifiers.`,
        { eventName, attributeName: "correlation" },
      ),
    );
  }
  return Effect.succeed(correlation);
};

const parseOutcome = (definition: CompiledEventDefinition, outcome: EventOutcome) =>
  decodeOutcome(outcome).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_OUTCOME",
        `Event "${definition.name}" has an invalid outcome. Use success, failure, or cancelled.`,
        { eventName: definition.name, attributeName: "event.outcome" },
      ),
    ),
  );

const parseSeverity = (eventName: string, severity: EventSeverity) =>
  decodeSeverity(severity).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has an invalid severity. Use debug, info, warn, error, or fatal.`,
        { eventName, attributeName: "event.severity" },
      ),
    ),
  );

const shouldRecord = Effect.fn("shouldRecord")(function* (
  definition: CompiledEventDefinition,
  outcome: EventOutcome,
): Effect.fn.Return<boolean> {
  if (
    definition.mandatory ||
    definition.kind === "audit" ||
    definition.kind === "defect" ||
    outcome === "failure" ||
    definition.sampling.kind === "always"
  ) {
    return true;
  }
  const draw = yield* Random.next;
  return draw < definition.sampling.rate;
});

const buildEvent = Effect.fn("buildEvent")(function* (
  definition: CompiledEventDefinition,
  contract: TelemetryContract<TelemetryContractInput>,
  attributes: EventAttributes,
  payload: EventPayloadForKind<
    "request" | "operation" | "domain" | "defect" | "audit",
    AttributeDefinitionsInput,
    TelemetryContractInput
  >,
): Effect.fn.Return<TelemetryEvent, InvalidTelemetryEvent> {
  const rawTimestamp =
    payload.timestamp ?? DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const timestamp = yield* parseTimestamp(definition.name, rawTimestamp);
  const severity = yield* parseSeverity(
    definition.name,
    payload.severity ?? definition.defaultSeverity,
  );
  const correlation = yield* parseCorrelation(definition.name, payload.correlation);
  const base = {
    timestamp,
    name: definition.name,
    severity,
    correlation,
    attributes,
  };
  switch (definition.kind) {
    case "request": {
      if (!("durationMs" in payload) || !("http" in payload) || !("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Request event "${definition.name}" requires outcome, durationMs, and http fields. Add every required field.`,
          { eventName: definition.name },
        );
      }
      const outcome = yield* parseOutcome(definition, payload.outcome);
      const durationMs = yield* parseDuration(definition.name, payload.durationMs);
      const http = yield* parseHttp(definition.name, payload.http);
      return { ...base, kind: "request", outcome, durationMs, http };
    }
    case "operation": {
      if (!("durationMs" in payload) || !("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Operation event "${definition.name}" requires outcome and durationMs. Add both fields.`,
          { eventName: definition.name },
        );
      }
      const outcome = yield* parseOutcome(definition, payload.outcome);
      const durationMs = yield* parseDuration(definition.name, payload.durationMs);
      return { ...base, kind: "operation", outcome, durationMs };
    }
    case "domain": {
      if (!("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Domain event "${definition.name}" requires an outcome. Add the required field.`,
          { eventName: definition.name },
        );
      }
      const outcome = yield* parseOutcome(definition, payload.outcome);
      return { ...base, kind: "domain", outcome };
    }
    case "defect": {
      if (!("error" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Defect event "${definition.name}" requires error context. Add error type, message, and retryable fields.`,
          { eventName: definition.name },
        );
      }
      if (payload.outcome !== undefined) {
        return yield* eventError(
          "OBS_EVENT_INVALID_OUTCOME",
          `Defect event "${definition.name}" has an invalid outcome. Defect outcomes are always failure.`,
          { eventName: definition.name, attributeName: "event.outcome" },
        );
      }
      const error = yield* parseError(definition.name, payload.error);
      return { ...base, kind: "defect", outcome: "failure", error };
    }
    case "audit": {
      if (!("audit" in payload) || !("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Audit event "${definition.name}" requires outcome and audit context. Add both fields.`,
          { eventName: definition.name },
        );
      }
      const outcome = yield* parseOutcome(definition, payload.outcome);
      const audit = yield* parseAudit(definition.name, payload.audit);
      const action = contract.auditActionByName.get(audit.action);
      if (action === undefined) {
        return yield* eventError(
          "OBS_EVENT_UNKNOWN_AUDIT_ACTION",
          `Audit event "${definition.name}" uses undeclared action "${audit.action}". Use a contract audit action.`,
          { eventName: definition.name, attributeName: "audit.action" },
        );
      }
      if (action.resourceType !== audit.resourceType) {
        return yield* eventError(
          "OBS_EVENT_INVALID_AUDIT_RESOURCE",
          `Audit action "${audit.action}" requires resource type "${action.resourceType}". Use the declared resource type.`,
          { eventName: definition.name, attributeName: "audit.resource.type" },
        );
      }
      if (!action.allowedOutcomes.includes(outcome)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_AUDIT_OUTCOME",
          `Audit action "${audit.action}" does not allow outcome "${outcome}". Use one of its declared outcomes.`,
          { eventName: definition.name, attributeName: "event.outcome" },
        );
      }
      return { ...base, kind: "audit", outcome, audit };
    }
  }
});

export const makeEventProducer = <const Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
): EventProducer<Definition> => ({
  emit: Effect.fn("EventProducer.emit")(function* (alias, payload) {
    const definition = contract.eventByAlias.get(alias);
    if (definition === undefined) {
      return yield* eventError(
        "OBS_EVENT_UNKNOWN_NAME",
        `Event alias "${alias}" is not declared by this telemetry contract. Use one of the contract aliases.`,
        { eventAlias: alias },
      );
    }
    const attributes = parseAttributes(definition, payload.attributes);
    if (attributes instanceof InvalidTelemetryEvent) {
      return yield* attributes;
    }
    const event = yield* buildEvent(definition, contract, attributes, payload);
    if (!(yield* shouldRecord(definition, event.outcome))) {
      return { decision: "sampled_out", name: definition.name };
    }
    const sink = yield* TelemetryEventSink;
    yield* sink.record(event);
    return { decision: "recorded", event };
  }),
});
