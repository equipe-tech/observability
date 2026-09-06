import { Worker } from "node:worker_threads";
import { Effect, Schema } from "effect";
import {
  TransportMessage,
  transportWorkerUrl,
  type TransportCommand,
  type TransportConfig,
} from "./EvlogTransportWorker.ts";

const decodeMessage = Schema.decodeUnknownSync(TransportMessage);

type TransportRecord = { readonly serialized: string; readonly auditRecordId?: string };

export type TransportAcceptance = "queued" | "queue-overflow" | "transport";

export type EvlogTransport<Item extends TransportRecord> = {
  readonly offer: (record: Item) => Promise<TransportAcceptance>;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly pending: number;
  readonly failed: boolean;
};

export const startEvlogTransport = <Item extends TransportRecord>(
  config: typeof TransportConfig.Type,
  delivered: (records: ReadonlyArray<Item>) => void,
  dropped: (records: ReadonlyArray<Item>, reason: "transport" | "count-overflow") => void,
): Effect.Effect<EvlogTransport<Item>, Error> =>
  Effect.try({
    try: () =>
      new Worker(new URL(transportWorkerUrl), {
        workerData: { kind: "observability-evlog-transport", config },
      }),
    catch: (cause) => new Error("The evlog transport worker could not be created.", { cause }),
  }).pipe(
    Effect.flatMap((worker) =>
      Effect.callback<EvlogTransport<Item>, Error>((resume) => {
        const records = new Map<number, Item>();
        const flushes = new Map<number, () => void>();
        const offers = new Map<number, (accepted: TransportAcceptance) => void>();
        let sequence = 0;
        let stopped = false;
        let failed = false;
        let termination: Promise<void> | undefined;
        const finish = (): void => {
          stopped = true;
          const abandoned = [...records.values()];
          records.clear();
          if (abandoned.length > 0) dropped(abandoned, "transport");
          for (const resolve of flushes.values()) resolve();
          flushes.clear();
          for (const resolve of offers.values()) resolve("transport");
          offers.clear();
        };
        const close = (): Promise<void> => {
          if (termination !== undefined) return termination;
          stopped = true;
          termination = worker.terminate().then(() => {
            finish();
          });
          return termination;
        };
        const send = (command: typeof TransportCommand.Type): void => worker.postMessage(command);
        const transport: EvlogTransport<Item> = {
          offer: (record) => {
            if (stopped) {
              dropped([record], "transport");
              return Promise.resolve("transport");
            }
            sequence += 1;
            records.set(sequence, record);
            const id = sequence;
            return new Promise<TransportAcceptance>((resolve) => {
              offers.set(id, resolve);
              send({
                kind: "offer",
                id,
                serialized: record.serialized,
                audit: record.auditRecordId !== undefined,
              });
            });
          },
          flush: () => {
            if (stopped) return termination ?? Promise.resolve();
            sequence += 1;
            const id = sequence;
            return new Promise<void>((resolve) => {
              flushes.set(id, resolve);
              send({ kind: "flush", id });
            });
          },
          close,
          get failed() {
            return failed;
          },
          get pending() {
            return records.size;
          },
        };
        worker.on("message", (input: typeof TransportMessage.Type) => {
          const message = decodeMessage(input);
          if (message.kind === "ready") {
            resume(Effect.succeed(transport));
          } else if (message.kind === "offered") {
            offers.get(message.id)?.(message.accepted ? "queued" : "queue-overflow");
            offers.delete(message.id);
          } else if (message.kind === "flushed") {
            flushes.get(message.id)?.();
            flushes.delete(message.id);
          } else {
            const completed: Array<Item> = [];
            for (const id of message.ids) {
              const record = records.get(id);
              if (record === undefined) continue;
              records.delete(id);
              completed.push(record);
            }
            if (message.kind === "delivered") delivered(completed);
            else dropped(completed, message.kind);
          }
        });
        worker.on("error", (error: Error) => {
          failed = true;
          finish();
          resume(Effect.fail(error));
        });
        worker.on("exit", () => {
          if (!stopped) failed = true;
          finish();
          resume(
            Effect.fail(new Error("The evlog transport worker exited before becoming ready.")),
          );
        });
        return Effect.promise(close);
      }),
    ),
  );
