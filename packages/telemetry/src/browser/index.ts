import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  BrowserEvent,
  BrowserEventBatch,
  encodeBrowserEventBatch,
  maxEventsPerBatch,
} from "../BrowserEvents.ts";
import type { EventAttributes } from "../contract/TelemetryEvent.ts";
import { BrowserClientEngine, normalizePositiveInteger } from "./BrowserClient.ts";

export {
  BrowserTelemetryClientDeliveryError,
  BrowserTelemetryClientShutdownError,
  browserBatchByteLength,
  createBrowserTelemetryClient,
} from "./BrowserClient.ts";
export type {
  BrowserTelemetryClient,
  BrowserTelemetryClientBatch,
  BrowserTelemetryClientConfig,
  BrowserTelemetryClientEvent,
  BrowserTelemetryClientFields,
  BrowserTelemetryClientTransport,
} from "./BrowserClient.ts";

export {
  BrowserEvent,
  BrowserEventBatch,
  browserRequestByteBudget,
  maxEventNameLength,
  maxEventsPerBatch,
  maxBrowserEventOccurredAt,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
} from "../BrowserEvents.ts";

export const defaultEventsEndpoint = "/_telemetry/events";

export class BrowserEventDeliveryError extends Schema.TaggedError<BrowserEventDeliveryError>()(
  "BrowserEventDeliveryError",
  {
    code: Schema.Literal("OBS_BROWSER_EVENTS_DELIVERY_FAILED"),
    message: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {}

export class BrowserEventTransport extends Context.Service<
  BrowserEventTransport,
  {
    send(batch: BrowserEventBatch): Effect.Effect<void, BrowserEventDeliveryError>;
  }
>()("@equipe-tech/observability/BrowserEventTransport") {
  static readonly layerFetch = (options?: {
    readonly endpoint?: string;
  }): Layer.Layer<BrowserEventTransport> => {
    const endpoint = options?.endpoint ?? defaultEventsEndpoint;
    return Layer.succeed(
      BrowserEventTransport,
      BrowserEventTransport.of({
        send: (batch) =>
          Effect.gen(function* () {
            const payload = yield* encodeBrowserEventBatch(batch).pipe(Effect.orDie);
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(endpoint, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(payload),
                  keepalive: true,
                  signal,
                }),
              catch: (cause) =>
                new BrowserEventDeliveryError({
                  code: "OBS_BROWSER_EVENTS_DELIVERY_FAILED",
                  message:
                    "The browser events could not be sent. The events stay queued and the next flush retries the same batch.",
                  retryable: true,
                  cause,
                }),
            });
            if (!response.ok) {
              return yield* new BrowserEventDeliveryError({
                code: "OBS_BROWSER_EVENTS_DELIVERY_FAILED",
                message: `The telemetry endpoint rejected the batch with status ${response.status}. Check the /_telemetry/events route of the project API.`,
                retryable: response.status === 429 || response.status >= 500,
                cause: response.status,
              });
            }
          }),
      }),
    );
  };
}

export type BrowserTelemetryOptions = {
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly flushInterval?: Duration.Input;
};

const makeBrowserTelemetry = Effect.fn("makeBrowserTelemetry")(function* (
  options?: BrowserTelemetryOptions,
) {
  const transport = yield* BrowserEventTransport;
  const flushInterval = Duration.fromInputUnsafe(options?.flushInterval ?? "5 seconds");
  const engine = new BrowserClientEngine({
    disabled: false,
    maxBatchSize: Math.min(normalizePositiveInteger(options?.maxBatchSize, 32), maxEventsPerBatch),
    maxQueueSize: normalizePositiveInteger(options?.maxQueueSize, 256),
    flushIntervalMs: normalizePositiveInteger(Duration.toMillis(flushInterval), 5_000),
    shutdownTimeoutMs: 2_000,
    transport: (batch) =>
      new Promise<void>((resolve, reject) => {
        Effect.runCallback(
          transport.send(
            new BrowserEventBatch({
              version: 1,
              events: batch.events.map((event) => new BrowserEvent(event)),
            }),
          ),
          {
            onExit: (exit) => {
              if (Exit.isSuccess(exit)) {
                resolve();
                return;
              }
              const failure = Cause.findErrorOption(exit.cause);
              reject(Option.isSome(failure) ? failure.value : Cause.squash(exit.cause));
            },
          },
        );
      }),
    startTimer: false,
  });

  const flush = Effect.tryPromise({
    try: () => engine.flush(),
    catch: (cause) =>
      cause instanceof BrowserEventDeliveryError
        ? cause
        : new BrowserEventDeliveryError({
            code: "OBS_BROWSER_EVENTS_DELIVERY_FAILED",
            message:
              "The browser events could not be sent. The events stay queued and the next flush retries the same batch.",
            retryable: true,
            cause,
          }),
  });

  yield* Effect.forkScoped(flush.pipe(Effect.ignore, Effect.delay(flushInterval), Effect.forever));
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({ try: () => engine.dispose(), catch: () => undefined }).pipe(Effect.ignore),
  );

  return {
    emit: (name: string, fields?: EventAttributes) =>
      Effect.sync(() => engine.emit(name, fields ?? {})),
    flush: () => flush,
    pending: () => Effect.sync(() => engine.pending()),
    dropped: () => Effect.sync(() => engine.dropped()),
  };
});

export class BrowserTelemetry extends Context.Service<
  BrowserTelemetry,
  {
    emit(name: string, fields?: EventAttributes): Effect.Effect<void>;
    flush(): Effect.Effect<void, BrowserEventDeliveryError>;
    pending(): Effect.Effect<number>;
    dropped(): Effect.Effect<number>;
  }
>()("@equipe-tech/observability/BrowserTelemetry") {
  static readonly layer = (
    options?: BrowserTelemetryOptions,
  ): Layer.Layer<BrowserTelemetry, never, BrowserEventTransport> =>
    Layer.effect(BrowserTelemetry, makeBrowserTelemetry(options));
}
