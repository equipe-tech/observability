import { parentPort, workerData } from "node:worker_threads";
import { Effect, Option, Schema } from "effect";
import { createDrainPipeline } from "evlog/pipeline";
import { sendBatchToOTLP } from "evlog/otlp";

export const transportWorkerUrl = import.meta.url;

export const TransportConfig = Schema.Struct({
  endpoint: Schema.String,
  serviceName: Schema.String,
  resourceAttributes: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ),
  maximumBufferedEvents: Schema.Int,
  batchSize: Schema.Int,
  batchIntervalMillis: Schema.Int,
  maximumAttempts: Schema.Int,
  initialRetryDelayMillis: Schema.Int,
  maximumRetryDelayMillis: Schema.Int,
  transportTimeoutMillis: Schema.Int,
  transportRetries: Schema.Int,
});

export const TransportCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("offer"),
    id: Schema.Int,
    serialized: Schema.String,
    audit: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("flush"), id: Schema.Int }),
]);

export const TransportMessage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("flushed"), id: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("offered"), id: Schema.Int, accepted: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literals(["delivered", "transport", "count-overflow"]),
    ids: Schema.Array(Schema.Int),
  }),
]);

const decodeStartup = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal("observability-evlog-transport"),
    config: TransportConfig,
  }),
);
const decodeCommand = Schema.decodeUnknownSync(TransportCommand);
const decodeEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    timestamp: Schema.String,
    level: Schema.Literals(["debug", "info", "warn", "error"]),
    service: Schema.String,
    environment: Schema.String,
  }),
  { onExcessProperty: "preserve" },
);

type BufferedEvent = { readonly id: number; readonly event: ReturnType<typeof decodeEvent> };

const startup = decodeStartup(workerData);
if (parentPort !== null && Option.isSome(startup)) {
  const port = parentPort;
  const config = startup.value.config;
  const pipeline = createDrainPipeline<BufferedEvent>({
    batch: { size: config.batchSize, intervalMs: config.batchIntervalMillis },
    retry: {
      maxAttempts: config.maximumAttempts,
      backoff: "exponential",
      initialDelayMs: config.initialRetryDelayMillis,
      maxDelayMs: config.maximumRetryDelayMillis,
    },
    maxBufferSize: config.maximumBufferedEvents,
    onDropped: (records, error) =>
      port.postMessage({
        kind: error === undefined ? "count-overflow" : "transport",
        ids: records.map((record) => record.id),
      } satisfies typeof TransportMessage.Type),
  })(async (records) => {
    await sendBatchToOTLP(
      records.map((record) => record.event),
      {
        endpoint: config.endpoint,
        serviceName: config.serviceName,
        resourceAttributes: config.resourceAttributes,
        timeout: config.transportTimeoutMillis,
        retries: config.transportRetries,
      },
    );
    port.postMessage({
      kind: "delivered",
      ids: records.map((record) => record.id),
    } satisfies typeof TransportMessage.Type);
  });
  port.on("message", (message: typeof TransportCommand.Type) => {
    const command = decodeCommand(message);
    if (command.kind === "offer") {
      const accepted = !command.audit || pipeline.pending < config.maximumBufferedEvents;
      if (accepted)
        pipeline({ id: command.id, event: decodeEvent(JSON.parse(command.serialized)) });
      else
        port.postMessage({
          kind: "count-overflow",
          ids: [command.id],
        } satisfies typeof TransportMessage.Type);
      port.postMessage({
        kind: "offered",
        id: command.id,
        accepted,
      } satisfies typeof TransportMessage.Type);
    } else {
      Effect.runFork(
        Effect.promise(async () => {
          await pipeline.flush();
          await pipeline.settled();
          port.postMessage({
            kind: "flushed",
            id: command.id,
          } satisfies typeof TransportMessage.Type);
        }),
      );
    }
  });
  port.postMessage({ kind: "ready" } satisfies typeof TransportMessage.Type);
}
