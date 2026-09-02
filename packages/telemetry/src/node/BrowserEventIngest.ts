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
          "The browser event batch is invalid. Send a batch with a positive safe integer version, bounded events, and scalar fields.",
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
  const events = batch.events.map((event) => {
    const decision = transformSignalFields(policy, "browser-ingest", event.fields);
    const errorDecision =
      event.error === undefined
        ? undefined
        : transformSignalFields(policy, "browser-ingest", {
            "error.type": event.error.type,
            "error.message": event.error.message,
          });
    const eventDropped = decision.dropped + (errorDecision?.dropped ?? 0);
    dropped += eventDropped;
    redacted += [...decision.redactions, ...(errorDecision?.redactions ?? [])].filter(
      (redaction) => redaction.action !== "dropped",
    ).length;
    const ingested = {
      id: event.id,
      name: event.name,
      occurredAt: event.occurredAt,
      attributes: decision.value,
      admission: { policyDroppedAttributes: eventDropped },
    };
    if (event.error === undefined || errorDecision === undefined) return ingested;
    return {
      ...ingested,
      error: {
        type: String(errorDecision.value["error.type"] ?? "Error"),
        message: String(errorDecision.value["error.message"] ?? ""),
        retryable: event.error.retryable,
      },
    };
  });
  yield* sink.recordBrowserBatch(events);
  return { accepted: events.length, redacted, dropped };
});

export const ingestBrowserEvents = flow(
  parseBrowserEventBatch,
  Effect.flatMap(ingestBrowserEventBatch),
);
