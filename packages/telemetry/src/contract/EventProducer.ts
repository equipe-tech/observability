import { Clock, Context, DateTime, Effect, Option, Random } from "effect";
import {
  type AttributeDefinitionsInput,
  type CompiledEventDefinition,
  type TelemetryContract,
  type TelemetryContractInput,
} from "./TelemetryContract.ts";
import {
  type AttributeValue,
  type AuditContext,
  type CorrelationContext,
  type ErrorContext,
  type EventAttributes,
  type EventOutcome,
  type EventSeverity,
  type HttpContext,
  type TelemetryEvent,
  isValidAttributeValue,
  isValidDuration,
  isValidTimestamp,
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

type EventPayloadForKind<
  Kind,
  Attributes extends AttributeDefinitionsInput,
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
          ? EventPayloadBase<Attributes> & {
              readonly outcome: EventOutcome;
              readonly audit: AuditContext;
            }
          : never;

export type EventPayloadOf<
  Definition extends TelemetryContractInput,
  Alias extends keyof Definition["events"] & string,
> = EventPayloadForKind<
  Definition["events"][Alias]["kind"],
  Definition["events"][Alias]["attributes"]
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
  eventName: string,
  attributeName?: string,
): InvalidTelemetryEvent => {
  if (attributeName === undefined) {
    return new InvalidTelemetryEvent({ code, message, eventName });
  }
  return new InvalidTelemetryEvent({ code, message, eventName, attributeName });
};

type EmittedAttributes = {
  readonly [attributeName: string]: AttributeValue | undefined;
};

const validateAttributes = (
  definition: CompiledEventDefinition,
  attributes: EmittedAttributes,
): InvalidTelemetryEvent | undefined => {
  for (const attributeName of definition.requiredAttributes) {
    if (!Object.hasOwn(attributes, attributeName)) {
      return eventError(
        "OBS_EVENT_MISSING_ATTRIBUTE",
        `Event "${definition.name}" is missing required attribute "${attributeName}". Add the declared scalar attribute before emitting.`,
        definition.name,
        attributeName,
      );
    }
  }
  for (const [attributeName, value] of Object.entries(attributes)) {
    if (!definition.attributes.has(attributeName)) {
      return eventError(
        "OBS_EVENT_UNDECLARED_ATTRIBUTE",
        `Event "${definition.name}" does not declare attribute "${attributeName}". Add it to the contract or remove it from the event.`,
        definition.name,
        attributeName,
      );
    }
    if (!isValidAttributeValue(value)) {
      return eventError(
        "OBS_EVENT_INVALID_FIELD",
        `Event "${definition.name}" has a non-scalar or non-finite value for "${attributeName}". Use a string, finite number, or boolean.`,
        definition.name,
        attributeName,
      );
    }
  }
};

const eventAttributes = (attributes: EmittedAttributes): EventAttributes => {
  const values: { [attributeName: string]: AttributeValue } = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      values[name] = value;
    }
  }
  return values;
};

const eventSeverities = new Set<string>(["debug", "info", "warn", "error", "fatal"]);
const eventOutcomes = new Set<string>(["success", "failure", "cancelled"]);

const invalidOutcome = (
  definition: CompiledEventDefinition,
  outcome: EventOutcome,
): InvalidTelemetryEvent | undefined => {
  if (eventOutcomes.has(outcome)) {
    return undefined;
  }
  return eventError(
    "OBS_EVENT_INVALID_OUTCOME",
    `Event "${definition.name}" has an invalid outcome. Use success, failure, or cancelled.`,
    definition.name,
  );
};

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
  payload: EventPayloadForKind<
    "request" | "operation" | "domain" | "defect" | "audit",
    AttributeDefinitionsInput
  >,
): Effect.fn.Return<TelemetryEvent, InvalidTelemetryEvent> {
  const timestamp =
    payload.timestamp ?? DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  if (!isValidTimestamp(timestamp)) {
    return yield* eventError(
      "OBS_EVENT_INVALID_FIELD",
      `Event "${definition.name}" has an invalid timestamp. Use an RFC 3339 UTC timestamp ending in Z.`,
      definition.name,
    );
  }
  const severity = payload.severity ?? definition.defaultSeverity;
  if (!eventSeverities.has(severity)) {
    return yield* eventError(
      "OBS_EVENT_INVALID_FIELD",
      `Event "${definition.name}" has an invalid severity. Use debug, info, warn, error, or fatal.`,
      definition.name,
    );
  }
  const base = {
    timestamp,
    name: definition.name,
    severity,
    correlation: payload.correlation ?? Option.none(),
    attributes: eventAttributes(payload.attributes),
  };
  switch (definition.kind) {
    case "request": {
      if (!("durationMs" in payload) || !("http" in payload) || !("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Request event "${definition.name}" requires outcome, durationMs, and http fields. Add every required field.`,
          definition.name,
        );
      }
      const outcomeError = invalidOutcome(definition, payload.outcome);
      if (outcomeError !== undefined) {
        return yield* outcomeError;
      }
      if (!isValidDuration(payload.durationMs)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Event "${definition.name}" has an invalid durationMs. Use a finite non-negative number.`,
          definition.name,
        );
      }
      return {
        ...base,
        kind: "request",
        outcome: payload.outcome,
        durationMs: payload.durationMs,
        http: payload.http,
      };
    }
    case "operation": {
      if (!("durationMs" in payload) || !("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Operation event "${definition.name}" requires outcome and durationMs. Add both fields.`,
          definition.name,
        );
      }
      const outcomeError = invalidOutcome(definition, payload.outcome);
      if (outcomeError !== undefined) {
        return yield* outcomeError;
      }
      if (!isValidDuration(payload.durationMs)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Event "${definition.name}" has an invalid durationMs. Use a finite non-negative number.`,
          definition.name,
        );
      }
      return {
        ...base,
        kind: "operation",
        outcome: payload.outcome,
        durationMs: payload.durationMs,
      };
    }
    case "domain": {
      if (!("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Domain event "${definition.name}" requires an outcome. Add the required field.`,
          definition.name,
        );
      }
      const outcomeError = invalidOutcome(definition, payload.outcome);
      if (outcomeError !== undefined) {
        return yield* outcomeError;
      }
      return { ...base, kind: "domain", outcome: payload.outcome };
    }
    case "defect": {
      if (!("error" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Defect event "${definition.name}" requires error context. Add error type, message, and retryable fields.`,
          definition.name,
        );
      }
      if (payload.outcome !== undefined) {
        return yield* eventError(
          "OBS_EVENT_INVALID_OUTCOME",
          `Defect event "${definition.name}" has an invalid outcome. Defect outcomes are always failure.`,
          definition.name,
        );
      }
      return { ...base, kind: "defect", outcome: "failure", error: payload.error };
    }
    case "audit": {
      if (!("audit" in payload) || !("outcome" in payload)) {
        return yield* eventError(
          "OBS_EVENT_INVALID_FIELD",
          `Audit event "${definition.name}" requires outcome and audit context. Add both fields.`,
          definition.name,
        );
      }
      const outcomeError = invalidOutcome(definition, payload.outcome);
      if (outcomeError !== undefined) {
        return yield* outcomeError;
      }
      return { ...base, kind: "audit", outcome: payload.outcome, audit: payload.audit };
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
        alias,
      );
    }
    const invalidAttributes = validateAttributes(definition, payload.attributes);
    if (invalidAttributes !== undefined) {
      return yield* invalidAttributes;
    }
    const event = yield* buildEvent(definition, payload);
    if (!(yield* shouldRecord(definition, event.outcome))) {
      return { decision: "sampled_out", name: definition.name };
    }
    const sink = yield* TelemetryEventSink;
    yield* sink.record(event);
    return { decision: "recorded", event };
  }),
});
