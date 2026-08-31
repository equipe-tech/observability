import { Schema } from "effect";
import { maxOtlpUnixTimestampMillis } from "./contract/TelemetryEvent.ts";
import {
  maxEventIdLength,
  maxEventNameLength,
  maxEventsPerBatch,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
} from "./browser/BrowserEventLimits.ts";

export {
  browserRequestByteBudget,
  maxEventIdLength,
  maxEventNameLength,
  maxEventsPerBatch,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
} from "./browser/BrowserEventLimits.ts";

export const maxBrowserEventOccurredAt = maxOtlpUnixTimestampMillis;

const BoundedFieldValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(maxFieldValueLength)),
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
]);

const BoundedFieldKey = Schema.NonEmptyString.check(Schema.isMaxLength(maxFieldKeyLength));

const BrowserEventFields = Schema.Record(BoundedFieldKey, BoundedFieldValue).check(
  Schema.makeFilter((fields) => Object.keys(fields).length <= maxFieldsPerEvent, {
    expected: `at most ${maxFieldsPerEvent} fields per event`,
  }),
);

export type BrowserEventFields = typeof BrowserEventFields.Type;

export class BrowserEventError extends Schema.Class<BrowserEventError>(
  "@equipe-tech/observability/BrowserEventError",
)({
  type: Schema.NonEmptyString.check(Schema.isMaxLength(maxFieldValueLength)),
  message: Schema.String.check(Schema.isMaxLength(maxFieldValueLength)),
  retryable: Schema.Boolean,
}) {}

export class BrowserEvent extends Schema.Class<BrowserEvent>(
  "@equipe-tech/observability/BrowserEvent",
)({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(maxEventIdLength)),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(maxEventNameLength)),
  occurredAt: Schema.Number.check(
    Schema.isFinite(),
    Schema.makeFilter((millis) => millis >= 0 && millis <= maxBrowserEventOccurredAt, {
      expected: `an epoch timestamp in milliseconds from 0 through ${maxBrowserEventOccurredAt}`,
    }),
  ),
  fields: BrowserEventFields,
  error: Schema.optional(BrowserEventError),
}) {}

export class BrowserEventBatch extends Schema.Class<BrowserEventBatch>(
  "@equipe-tech/observability/BrowserEventBatch",
)({
  version: Schema.Literal(1),
  events: Schema.Array(BrowserEvent).check(
    Schema.makeFilter((events) => events.length <= maxEventsPerBatch, {
      expected: `at most ${maxEventsPerBatch} events per batch`,
    }),
  ),
}) {}

export const encodeBrowserEventBatch = Schema.encodeEffect(BrowserEventBatch);
