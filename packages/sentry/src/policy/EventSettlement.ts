import type { DefectEnvelope } from "@equipe-tech/observability/policy";
import type { DefectDeduplicator } from "./Deduplication.ts";

type PendingEvent = {
  readonly input: { readonly envelope: DefectEnvelope };
  readonly resolve: (accepted: boolean) => void;
};

export type EventSettlements = {
  readonly reserve: (
    eventId: string,
    input: { readonly envelope: DefectEnvelope },
  ) => Promise<boolean> | undefined;
  readonly input: (eventId: string) => { readonly envelope: DefectEnvelope } | undefined;
  readonly settle: (eventId: string, accepted: boolean) => void;
  readonly reject: (eventId: string) => void;
  readonly clear: () => void;
  readonly size: () => number;
};

export const eventSettlements = (
  capacity: number,
  dedupe: DefectDeduplicator,
): EventSettlements => {
  const entries = new Map<string, PendingEvent>();
  const settle = (eventId: string, accepted: boolean): void => {
    const entry = entries.get(eventId);
    if (entry === undefined) return;
    entries.delete(eventId);
    if (accepted) dedupe.release(eventId);
    else dedupe.rollback(eventId);
    entry.resolve(accepted);
  };
  return {
    reserve: (eventId, input) => {
      if (entries.size >= capacity) return undefined;
      let resolve = (_accepted: boolean): void => {};
      const completion = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      entries.set(eventId, { input, resolve });
      return completion;
    },
    input: (eventId) => entries.get(eventId)?.input,
    settle,
    reject: (eventId) => settle(eventId, false),
    clear: () => {
      for (const eventId of entries.keys()) settle(eventId, false);
    },
    size: () => entries.size,
  };
};
