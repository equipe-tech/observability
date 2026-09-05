import { Clock, Context, DateTime, Effect, Predicate, Random, Schema } from "effect";
import { CorrelationContext, CurrentCorrelation } from "../Correlation.ts";
import {
  type AttributeDefinitionsInput,
  type AuditActionDefinitionInput,
  type CompiledEventDefinition,
  type TelemetryContract,
  type TelemetryContractInput,
  validateContractEvent,
} from "./TelemetryContract.ts";
import type { BrowserEventError, BrowserTraceContext } from "../BrowserEvents.ts";
import {
  AuditContext,
  type AuditActor,
  type AttributeValue,
  ErrorContext,
  EventDuration,
  type EventAttributes,
  EventOutcome,
  EventSeverity,
  EventTimestamp,
  HttpContext,
  type TelemetryEvent,
} from "./TelemetryEvent.ts";
import { CurrentDataPolicy, type DataPolicy } from "../policy/DataPolicy.ts";
import { transformSignalFields } from "../policy/PolicyTransform.ts";
import { sensitiveFieldReplacement } from "../policy/PolicyVocabulary.ts";
import type { PolicyRedaction } from "../policy/PolicyTransform.ts";
import { InvalidTelemetryEvent } from "./TelemetryContractError.ts";

export type EventAdmissionMetadata = {
  readonly policyDroppedAttributes: number;
};

export type BrowserTelemetryEvent = {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: number;
  readonly attributes: EventAttributes;
  readonly error?: BrowserEventError;
  readonly trace?: BrowserTraceContext;
  readonly admission: EventAdmissionMetadata;
};

export class TelemetryEventSink extends Context.Service<
  TelemetryEventSink,
  {
    readonly record: (
      event: TelemetryEvent,
      admission: EventAdmissionMetadata,
    ) => Effect.Effect<void, InvalidTelemetryEvent>;
    readonly recordBrowserBatch: (
      events: ReadonlyArray<BrowserTelemetryEvent>,
    ) => Effect.Effect<void, InvalidTelemetryEvent>;
  }
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
  readonly correlation?: CorrelationContext;
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
  | {
      readonly decision: "recorded";
      readonly event: TelemetryEvent;
      readonly redactions: ReadonlyArray<PolicyRedaction>;
      readonly admission: EventAdmissionMetadata;
    }
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

const parseEventPayload = <Payload>(
  definition: CompiledEventDefinition,
  payload: Payload,
): InvalidTelemetryEvent | Payload => {
  if (!Predicate.isObject(payload)) {
    return eventError(
      "OBS_EVENT_INVALID_FIELD",
      `Event "${definition.name}" has an invalid payload. Use an event payload object with declared fields.`,
      { eventName: definition.name, attributeName: "payload" },
    );
  }
  return payload;
};

const parseAttributes = (
  policy: DataPolicy,
  contract: TelemetryContract<TelemetryContractInput>,
  definition: CompiledEventDefinition,
  attributes: EmittedAttributes,
):
  | InvalidTelemetryEvent
  | {
      readonly attributes: EventAttributes;
      readonly redactions: ReadonlyArray<PolicyRedaction>;
      readonly admission: EventAdmissionMetadata;
    } => {
  if (!Predicate.isObject(attributes)) {
    return eventError(
      "OBS_EVENT_INVALID_FIELD",
      `Event "${definition.name}" has invalid attributes. Use a declared scalar attribute object.`,
      { eventName: definition.name, attributeName: "attributes" },
    );
  }
  const parsed: { [attributeName: string]: AttributeValue } = {};
  const contractRedactions: Array<PolicyRedaction> = [];
  for (const [attributeName, value] of Object.entries(attributes)) {
    const attribute = definition.attributes.get(attributeName);
    if (
      value === undefined ||
      (!Predicate.isString(value) &&
        !Predicate.isBoolean(value) &&
        (!Predicate.isNumber(value) || !Number.isFinite(value)))
    ) {
      return eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${definition.name}" has a non-scalar or non-finite value for "${attributeName}". Use a string, finite number, or boolean.`,
        { eventName: definition.name, attributeName },
      );
    }
    if (attribute === undefined) {
      parsed[attributeName] = value;
      continue;
    }
    if (attribute.classification === "forbidden") {
      return eventError(
        "OBS_EVENT_RESTRICTED_ATTRIBUTE",
        `Event "${definition.name}" cannot emit forbidden attribute "${attributeName}". Remove the attribute before emitting.`,
        { eventName: definition.name, attributeName },
      );
    }
    if (attribute.classification === "sensitive" && attribute.metricLabel) {
      return eventError(
        "OBS_EVENT_SENSITIVE_METRIC_LABEL",
        `Event "${definition.name}" cannot use sensitive attribute "${attributeName}" as a metric label. Remove the metric label declaration.`,
        { eventName: definition.name, attributeName },
      );
    }
    parsed[attributeName] =
      attribute.classification === "sensitive" ? sensitiveFieldReplacement : value;
    if (
      attribute.classification === "sensitive" &&
      policy.classify(attributeName) !== "sensitive"
    ) {
      contractRedactions.push({ rule: "classification", action: "masked", surface: "event" });
    }
  }
  const validation = validateContractEvent(contract, definition.name, parsed);
  if (validation instanceof InvalidTelemetryEvent) {
    return validation;
  }
  const decision = transformSignalFields(policy, "event", parsed);
  return {
    attributes: decision.value,
    redactions: [...contractRedactions, ...decision.redactions],
    admission: { policyDroppedAttributes: decision.dropped },
  };
};

const decodeSeverity = Schema.decodeUnknownEffect(EventSeverity);
const decodeOutcome = Schema.decodeUnknownEffect(EventOutcome);
const decodeTimestamp = Schema.decodeUnknownEffect(EventTimestamp);
const decodeDuration = Schema.decodeUnknownEffect(EventDuration);
const decodeHttp = Schema.decodeUnknownEffect(HttpContext);
const decodeError = Schema.decodeUnknownEffect(ErrorContext);
const decodeAudit = Schema.decodeUnknownEffect(AuditContext);
const decodeCorrelation = Schema.decodeUnknownEffect(CorrelationContext);

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
  correlation: CorrelationContext | undefined,
): Effect.Effect<CorrelationContext, InvalidTelemetryEvent> => {
  if (correlation === undefined) {
    return CurrentCorrelation;
  }
  return decodeCorrelation(correlation).pipe(
    Effect.mapError(() =>
      eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${eventName}" has invalid correlation context. Use traced or untraced linkage with bounded request and run identifiers.`,
        { eventName, attributeName: "correlation" },
      ),
    ),
  );
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
    const parsedPayload = parseEventPayload(definition, payload);
    if (parsedPayload instanceof InvalidTelemetryEvent) {
      return yield* parsedPayload;
    }
    const policy = yield* CurrentDataPolicy;
    const parsedAttributes = parseAttributes(
      policy,
      contract,
      definition,
      parsedPayload.attributes,
    );
    if (parsedAttributes instanceof InvalidTelemetryEvent) {
      return yield* parsedAttributes;
    }
    const event = yield* buildEvent(
      definition,
      contract,
      parsedAttributes.attributes,
      parsedPayload,
    );
    if (!(yield* shouldRecord(definition, event.outcome))) {
      return { decision: "sampled_out", name: definition.name };
    }
    const sink = yield* TelemetryEventSink;
    yield* sink.record(event, parsedAttributes.admission);
    return {
      decision: "recorded",
      event,
      redactions: parsedAttributes.redactions,
      admission: parsedAttributes.admission,
    };
  }),
});
