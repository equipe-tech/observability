import type { DefectDeduplicator } from "./Deduplication.ts";
type PendingEvent<Event> = {
  readonly input: Event;
  readonly resolve: (accepted: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export type EventSettlements<Event> = {
  readonly reserve: (eventId: string, input: Event) => Promise<boolean> | undefined;
  readonly input: (eventId: string) => Event | undefined;
  readonly settle: (eventId: string, accepted: boolean) => void;
  readonly reject: (eventId: string) => void;
  readonly clear: () => void;
  readonly size: () => number;
};

export const eventSettlements = <Event>(
  capacity: number,
  deadlineMillis: number,
  dedupe: DefectDeduplicator,
): EventSettlements<Event> => {
  const entries = new Map<string, PendingEvent<Event>>();
  const settle = (eventId: string, accepted: boolean): void => {
    const entry = entries.get(eventId);
    if (entry === undefined) return;
    entries.delete(eventId);
    clearTimeout(entry.timer);
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
      const timer = setTimeout(() => settle(eventId, false), deadlineMillis);
      timer.unref?.();
      entries.set(eventId, { input, resolve, timer });
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
