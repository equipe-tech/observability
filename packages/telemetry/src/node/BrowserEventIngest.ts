import { Effect, flow, Schema } from "effect";
import { BrowserEventBatch } from "../BrowserEvents.ts";
import { CurrentDataPolicy } from "../policy/DataPolicy.ts";
import { transformSignalFields } from "../policy/PolicyTransform.ts";
import * as WideEvent from "../WideEvent.ts";

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
): Effect.fn.Return<BrowserEventIngestReceipt, never> {
  const policy = yield* CurrentDataPolicy;
  let redacted = 0;
  let dropped = 0;
  for (const event of batch.events) {
    const decision = transformSignalFields(policy, "browser-ingest", event.fields);
    dropped += Object.keys(event.fields).length - Object.keys(decision.value).length;
    for (const [key, value] of Object.entries(decision.value)) {
      if (event.fields[key] !== value) redacted += 1;
    }
    yield* WideEvent.emit(event.name, {
      ...decision.value,
      "event.source": "browser",
      "browser.event.id": event.id,
      "browser.event.occurred_at": event.occurredAt,
    });
  }
  return { accepted: batch.events.length, redacted, dropped };
});

export const ingestBrowserEvents = flow(
  parseBrowserEventBatch,
  Effect.flatMap(ingestBrowserEventBatch),
);
