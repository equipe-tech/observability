import { Schema } from "effect";

const eventNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;
const attributeNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const numericIdentifierPattern = /^\d+$/;
const uuidIdentifierPattern = /^[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/;
const longIdentifierPattern = /^(?=[a-z0-9_]{12,}$)(?=.*[a-z])(?=.*\d)[a-z0-9_]+$/;

const reservedEventParts = new Set([
  "production",
  "prod",
  "staging",
  "stage",
  "development",
  "dev",
  "test",
  "local",
  "sandbox",
  "qa",
  "preview",
  "debug",
  "info",
  "warn",
  "warning",
  "fatal",
  "critical",
  "trace",
  "verbose",
  "severity",
  "success",
  "succeeded",
  "failure",
  "failed",
  "cancelled",
  "canceled",
  "ok",
  "outcome",
  "errored",
  "error",
]);

export const isReservedEventNamePart = (part: string): boolean => reservedEventParts.has(part);

export const EventName = Schema.String.check(
  Schema.makeFilter((name) => isValidEventName(name), { expected: "a valid telemetry event name" }),
).pipe(Schema.brand("EventName"));
export type EventName = typeof EventName.Type;

export const isValidEventName = (name: string): boolean => {
  if (name.length > 128 || !eventNamePattern.test(name)) {
    return false;
  }
  if (name === "browser.error") {
    return true;
  }
  return name
    .split(".")
    .every(
      (part) =>
        !isReservedEventNamePart(part) &&
        !numericIdentifierPattern.test(part) &&
        !uuidIdentifierPattern.test(part) &&
        !longIdentifierPattern.test(part),
    );
};

export const isValidAttributeName = (name: string): boolean =>
  name.length <= 128 && attributeNamePattern.test(name);
