import { DateTime, Option, Schema } from "effect";
import type { CorrelationContext } from "../Correlation.ts";
import type { EventName } from "./EventName.ts";

export const EventSeverity = Schema.Literals(["debug", "info", "warn", "error", "fatal"]);
export type EventSeverity = typeof EventSeverity.Type;

export const EventOutcome = Schema.Literals(["success", "failure", "cancelled"]);
export type EventOutcome = typeof EventOutcome.Type;

export const EventKind = Schema.Literals(["request", "operation", "domain", "defect", "audit"]);
export type EventKind = typeof EventKind.Type;

export type AttributeValue = string | number | boolean;

export type EventAttributes = {
  readonly [attributeName: string]: AttributeValue;
};

export const HttpContext = Schema.Struct({
  method: Schema.NonEmptyString,
  route: Schema.NonEmptyString,
  statusCode: Schema.Int.check(
    Schema.makeFilter((statusCode) => statusCode >= 100 && statusCode <= 599, {
      expected: "an HTTP status code from 100 to 599",
    }),
  ),
});
export type HttpContext = typeof HttpContext.Type;

export const ErrorContext = Schema.Struct({
  type: Schema.NonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ErrorContext = typeof ErrorContext.Type;

export const AuditActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), id: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("service"), id: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("system") }),
]);
export type AuditActor = typeof AuditActor.Type;

export const AuditContext = Schema.Struct({
  action: Schema.NonEmptyString,
  actor: AuditActor,
  resourceType: Schema.NonEmptyString,
  resourceId: Schema.NonEmptyString,
});
export type AuditContext = typeof AuditContext.Type;

const rfc3339UtcPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isValidTimestamp = (timestamp: string): boolean => {
  const parts = rfc3339UtcPattern.exec(timestamp);
  if (parts === null) {
    return false;
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Option.isSome(DateTime.make(timestamp))
  );
};

export const EventTimestamp = Schema.String.check(
  Schema.makeFilter(isValidTimestamp, { expected: "an RFC 3339 UTC timestamp" }),
).pipe(Schema.brand("EventTimestamp"));
export type EventTimestamp = typeof EventTimestamp.Type;

export const EventDuration = Schema.Finite.check(
  Schema.makeFilter((durationMs) => durationMs >= 0, {
    expected: "a finite non-negative duration",
  }),
).pipe(Schema.brand("EventDuration"));
export type EventDuration = typeof EventDuration.Type;

export type EventBase = {
  readonly timestamp: EventTimestamp;
  readonly name: EventName;
  readonly severity: EventSeverity;
  readonly correlation: CorrelationContext;
  readonly attributes: EventAttributes;
};

export type TelemetryEvent =
  | (EventBase & {
      readonly kind: "request";
      readonly outcome: EventOutcome;
      readonly durationMs: EventDuration;
      readonly http: HttpContext;
    })
  | (EventBase & {
      readonly kind: "operation";
      readonly outcome: EventOutcome;
      readonly durationMs: EventDuration;
    })
  | (EventBase & { readonly kind: "domain"; readonly outcome: EventOutcome })
  | (EventBase & {
      readonly kind: "defect";
      readonly outcome: "failure";
      readonly error: ErrorContext;
    })
  | (EventBase & {
      readonly kind: "audit";
      readonly outcome: EventOutcome;
      readonly audit: AuditContext;
    });
