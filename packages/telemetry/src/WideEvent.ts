import { Effect } from "effect";
import { sanitizeEventName } from "./policy/BrowserFieldPolicy.ts";
import { CurrentDataPolicy } from "./policy/DataPolicy.ts";
import { transformSignalFields } from "./policy/PolicyTransform.ts";

export type WideEventFields = {
  readonly [attribute: string]: string | number | boolean;
};

export const emit = Effect.fn("WideEvent.emit")(function* (
  name: string,
  fields: WideEventFields,
): Effect.fn.Return<void> {
  const policy = yield* CurrentDataPolicy;
  const decision = transformSignalFields(policy, "log", fields);
  const eventName = sanitizeEventName(name);
  yield* Effect.logInfo(eventName).pipe(
    Effect.annotateLogs({
      ...decision.value,
      "event.name": eventName,
      "event.kind": "wide",
    }),
  );
});
