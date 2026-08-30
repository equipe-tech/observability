import { Effect, flow, Schema } from "effect";
import { BrowserEventBatch } from "../BrowserEvents.ts";
import { TelemetryEventSink } from "../contract/EventProducer.ts";
import { CurrentDataPolicy } from "../policy/DataPolicy.ts";
import { transformSignalFields } from "../policy/PolicyTransform.ts";

export class InvalidBrowserEventBatch extends Schema.TaggedError<InvalidBrowserEventBatch>()(
  "InvalidBrowserEventBatch",
  {
    code: Schema.Literal("OBS_BROWSER_EVENTS_INVALID_BATCH"),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeBrowserEventBatch = Schema.decodeUnknownEffect(BrowserEventBatch);

export const parseBrowserEventBatch = flow(
  decodeBrowserEventBatch,
  Effect.mapError(
    (cause) =>
      new InvalidBrowserEventBatch({
        code: "OBS_BROWSER_EVENTS_INVALID_BATCH",
        message:
          "The browser event batch is invalid. Send a version 1 batch with bounded events and scalar fields.",
        cause,
      }),
  ),
);

export type BrowserEventIngestReceipt = {
  readonly accepted: number;
  readonly redacted: number;
  readonly dropped: number;
};

export const ingestBrowserEventBatch = Effect.fn("ingestBrowserEventBatch")(function* (
  batch: BrowserEventBatch,
) {
  const policy = yield* CurrentDataPolicy;
  const sink = yield* TelemetryEventSink;
  let redacted = 0;
  let dropped = 0;
  for (const event of batch.events) {
    const decision = transformSignalFields(policy, "browser-ingest", event.fields);
    dropped += decision.dropped;
    redacted += decision.redactions.filter((redaction) => redaction.action !== "dropped").length;
    yield* sink.recordBrowser({
      id: event.id,
      name: event.name,
      occurredAt: event.occurredAt,
      attributes: decision.value,
      admission: { policyDroppedAttributes: decision.dropped },
    });
  }
  return { accepted: batch.events.length, redacted, dropped };
});

export const ingestBrowserEvents = flow(
  parseBrowserEventBatch,
  Effect.flatMap(ingestBrowserEventBatch),
);
