import { Effect } from "effect";
import { sanitizeBrowserEventName } from "./policy/BrowserFieldPolicy.ts";
import { CurrentDataPolicy } from "./policy/DataPolicy.ts";
import { sanitizeSignalFields } from "./policy/SignalPolicy.ts";

export type WideEventFields = {
  readonly [attribute: string]: string | number | boolean;
};

export const emit = Effect.fn("WideEvent.emit")(function* (
  name: string,
  fields: WideEventFields,
): Effect.fn.Return<void> {
  const policy = yield* CurrentDataPolicy;
  const decision = sanitizeSignalFields(policy, "log", fields);
  const eventName = sanitizeBrowserEventName(name);
  yield* Effect.logInfo(eventName).pipe(
    Effect.annotateLogs({
      ...decision.value,
      "event.name": eventName,
      "event.kind": "wide",
    }),
  );
});
