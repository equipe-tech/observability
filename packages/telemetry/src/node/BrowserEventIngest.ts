import { Effect, flow, Schema } from "effect";
import { BrowserEventBatch, type BrowserEventFields } from "../BrowserEvents.ts";
import type { WideEventFields } from "../WideEvent.ts";
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

const reservedFieldPrefixes = ["event.", "browser."];

const trustedFields = (fields: BrowserEventFields): WideEventFields => {
  const sanitized: { [attribute: string]: string | number | boolean } = {};
  for (const [key, value] of Object.entries(fields)) {
    if (reservedFieldPrefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
};

export type BrowserEventIngestReceipt = {
  readonly accepted: number;
};

export const ingestBrowserEventBatch = Effect.fn("ingestBrowserEventBatch")(function* (
  batch: BrowserEventBatch,
): Effect.fn.Return<BrowserEventIngestReceipt, never> {
  for (const event of batch.events) {
    yield* WideEvent.emit(event.name, {
      ...trustedFields(event.fields),
      "event.source": "browser",
      "browser.event.id": event.id,
      "browser.event.occurred_at": event.occurredAt,
    });
  }
  return { accepted: batch.events.length };
});

export const ingestBrowserEvents = flow(
  parseBrowserEventBatch,
  Effect.flatMap(ingestBrowserEventBatch),
);
