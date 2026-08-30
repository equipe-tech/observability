import { Effect } from "effect";
import type { EventAttributes } from "../contract/TelemetryEvent.ts";
import { sanitizeEventName } from "../policy/BrowserFieldPolicy.ts";
import { CurrentDataPolicy } from "../policy/DataPolicy.ts";
import { transformSignalFields } from "../policy/PolicyTransform.ts";
import { effectDroppedAttributesKey } from "../policy/PolicyVocabulary.ts";

export type WideEventFields = EventAttributes;

export const emit = (name: string, fields: WideEventFields): Effect.Effect<void> =>
  Effect.flatMap(CurrentDataPolicy, (policy) => {
    const applicationFields = { ...fields };
    delete applicationFields["event.name"];
    delete applicationFields["event.kind"];
    const eventName = sanitizeEventName(name);
    const decision = transformSignalFields(policy, "log", {
      "event.name": eventName,
      "event.kind": "wide",
      ...applicationFields,
    });
    return Effect.logInfo(eventName).pipe(
      Effect.annotateLogs({
        ...decision.value,
        [effectDroppedAttributesKey]: decision.dropped,
      }),
    );
  });
