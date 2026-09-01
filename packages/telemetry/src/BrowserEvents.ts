import { Schema } from "effect";
import { maxOtlpUnixTimestampMillis } from "./contract/TelemetryEvent.ts";
import {
  browserEnvelopeVersion,
  maxEventIdLength,
  maxEventNameLength,
  maxEventsPerBatch,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
} from "./browser/BrowserEventLimits.ts";

export {
  browserEnvelopeVersion,
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

const BrowserEventDocument = {
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
};

export class BrowserEvent extends Schema.Class<BrowserEvent>(
  "@equipe-tech/observability/BrowserEvent",
)(BrowserEventDocument) {}

const BrowserEventBatchDocument = {
  version: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.makeFilter(Number.isSafeInteger, { expected: "a positive safe integer" }),
  ),
  events: Schema.Array(BrowserEvent).check(
    Schema.makeFilter((events) => events.length <= maxEventsPerBatch, {
      expected: `at most ${maxEventsPerBatch} events per batch`,
    }),
  ),
};

export class BrowserEventBatch extends Schema.Class<BrowserEventBatch>(
  "@equipe-tech/observability/BrowserEventBatch",
)(BrowserEventBatchDocument) {}

export const browserEnvelopeMetadata = {
  version: browserEnvelopeVersion,
  batchFields: Object.keys(BrowserEventBatchDocument).sort(),
  eventFields: Object.keys(BrowserEventDocument).sort(),
};

export const encodeBrowserEventBatch = Schema.encodeEffect(BrowserEventBatch);
