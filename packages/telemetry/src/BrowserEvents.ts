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

const BrowserTraceId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{32}$/),
  Schema.makeFilter((value) => value !== "00000000000000000000000000000000", {
    expected: "a non-zero W3C trace identifier",
  }),
);

const BrowserSpanId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{16}$/),
  Schema.makeFilter((value) => value !== "0000000000000000", {
    expected: "a non-zero W3C span identifier",
  }),
);

export type BrowserEventFields = typeof BrowserEventFields.Type;

export class BrowserResourceIdentity extends Schema.Class<BrowserResourceIdentity>(
  "@equipe-tech/observability/BrowserResourceIdentity",
)({
  serviceName: Schema.NonEmptyString,
  serviceVersion: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
}) {}

export class BrowserTraceContext extends Schema.Class<BrowserTraceContext>(
  "@equipe-tech/observability/BrowserTraceContext",
)({
  traceId: BrowserTraceId,
  spanId: BrowserSpanId,
}) {}

export class BrowserTraceSpan extends Schema.Class<BrowserTraceSpan>(
  "@equipe-tech/observability/BrowserTraceSpan",
)({
  traceId: BrowserTraceId,
  spanId: BrowserSpanId,
  parentSpanId: Schema.optional(BrowserSpanId),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(maxEventNameLength)),
  startedAt: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 0, maximum: maxBrowserEventOccurredAt }),
  ),
  endedAt: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 0, maximum: maxBrowserEventOccurredAt }),
  ),
  fields: BrowserEventFields,
}) {}

export class BrowserMetricPoint extends Schema.Class<BrowserMetricPoint>(
  "@equipe-tech/observability/BrowserMetricPoint",
)({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(maxEventNameLength)),
  value: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  occurredAt: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 0, maximum: maxBrowserEventOccurredAt }),
  ),
  fields: BrowserEventFields,
}) {}

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
  trace: Schema.optional(BrowserTraceContext),
};

export class BrowserEvent extends Schema.Class<BrowserEvent>(
  "@equipe-tech/observability/BrowserEvent",
)(BrowserEventDocument) {}

const BrowserEventBatchDocument = {
  version: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.makeFilter(Number.isSafeInteger, { expected: "a positive safe integer" }),
  ),
  resource: Schema.optional(BrowserResourceIdentity),
  events: Schema.Array(BrowserEvent).check(
    Schema.makeFilter((events) => events.length <= maxEventsPerBatch, {
      expected: `at most ${maxEventsPerBatch} events per batch`,
    }),
  ),
  spans: Schema.optional(
    Schema.Array(BrowserTraceSpan).check(
      Schema.makeFilter((spans) => spans.length <= maxEventsPerBatch, {
        expected: `at most ${maxEventsPerBatch} spans per batch`,
      }),
    ),
  ),
  metrics: Schema.optional(
    Schema.Array(BrowserMetricPoint).check(
      Schema.makeFilter((metrics) => metrics.length <= maxEventsPerBatch, {
        expected: `at most ${maxEventsPerBatch} metric points per batch`,
      }),
    ),
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
