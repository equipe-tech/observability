import { Schema } from "effect";

const eventNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;
const attributeNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const identifierPattern =
  /^(?:[0-9a-f]{6,}|[a-z0-9_]*[0-9]{4,}[a-z0-9_]*|[0-9a-f]{8}_[0-9a-f_]{27,})$/;

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
    .every((part) => !reservedEventParts.has(part) && !identifierPattern.test(part));
};

export const isValidAttributeName = (name: string): boolean =>
  name.length <= 128 && attributeNamePattern.test(name);
