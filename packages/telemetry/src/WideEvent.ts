import { Effect } from "effect";

export type WideEventFields = {
  readonly [attribute: string]: string | number | boolean;
};

export const emit = (name: string, fields: WideEventFields): Effect.Effect<void> =>
  Effect.logInfo(name).pipe(
    Effect.annotateLogs({
      ...fields,
      "event.name": name,
      "event.kind": "wide",
    }),
  );
