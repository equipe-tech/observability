import { Effect } from "effect";
import { sanitizeEventName } from "./policy/BrowserFieldPolicy.ts";
import { CurrentDataPolicy } from "./policy/DataPolicy.ts";
import { transformSignalFields } from "./policy/PolicyTransform.ts";
import { effectDroppedAttributesKey } from "./policy/PolicyVocabulary.ts";

export type WideEventFields = {
  readonly [attribute: string]: string | number | boolean;
};

export const emit = (name: string, fields: WideEventFields): Effect.Effect<void> =>
  Effect.flatMap(CurrentDataPolicy, (policy) => {
    const decision = transformSignalFields(policy, "log", fields);
    const eventName = sanitizeEventName(name);
    return Effect.logInfo(eventName).pipe(
      Effect.annotateLogs({
        ...decision.value,
        "event.name": eventName,
        "event.kind": "wide",
        [effectDroppedAttributesKey]: decision.dropped,
      }),
    );
  });
