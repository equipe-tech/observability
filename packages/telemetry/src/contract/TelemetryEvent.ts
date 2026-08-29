import { DateTime, Option, Predicate, Schema } from "effect";
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

export type CorrelationContext = {
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly requestId: Option.Option<string>;
  readonly runId: Option.Option<string>;
};

export type HttpContext = {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
};

export type ErrorContext = {
  readonly type: string;
  readonly message: string;
  readonly retryable: boolean;
};

export type AuditActor =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "service"; readonly id: string }
  | { readonly kind: "system" };

export type AuditContext = {
  readonly action: string;
  readonly actor: AuditActor;
  readonly resourceType: string;
  readonly resourceId: string;
};

export type EventBase = {
  readonly timestamp: string;
  readonly name: EventName;
  readonly severity: EventSeverity;
  readonly correlation: Option.Option<CorrelationContext>;
  readonly attributes: EventAttributes;
};

export type TelemetryEvent =
  | (EventBase & {
      readonly kind: "request";
      readonly outcome: EventOutcome;
      readonly durationMs: number;
      readonly http: HttpContext;
    })
  | (EventBase & {
      readonly kind: "operation";
      readonly outcome: EventOutcome;
      readonly durationMs: number;
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

export const rfc3339UtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const isValidDuration = (durationMs: number): boolean =>
  Number.isFinite(durationMs) && durationMs >= 0;

export const isValidTimestamp = (timestamp: string): boolean =>
  rfc3339UtcPattern.test(timestamp) && Option.isSome(DateTime.make(timestamp));

export const isValidAttributeValue = (value: AttributeValue | undefined): boolean =>
  Predicate.isString(value) ||
  Predicate.isBoolean(value) ||
  (Predicate.isNumber(value) && Number.isFinite(value));
