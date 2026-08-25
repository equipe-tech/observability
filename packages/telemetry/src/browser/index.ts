import { Clock, Context, Duration, Effect, Layer, Predicate, Ref, Schema } from "effect";
import {
  BrowserEvent,
  BrowserEventBatch,
  encodeBrowserEventBatch,
  maxEventNameLength,
  maxEventsPerBatch,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
  type BrowserEventFields,
} from "../BrowserEvents.ts";
import type { WideEventFields } from "../WideEvent.ts";

export {
  BrowserEvent,
  BrowserEventBatch,
  maxEventNameLength,
  maxEventsPerBatch,
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

type EventQueue = {
  readonly events: ReadonlyArray<BrowserEvent>;
  readonly dropped: number;
};

const clampFields = (fields: WideEventFields): BrowserEventFields => {
  const clamped: { [attribute: string]: string | number | boolean } = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "" || count >= maxFieldsPerEvent) {
      continue;
    }
    const boundedKey = key.slice(0, maxFieldKeyLength);
    clamped[boundedKey] = Predicate.isString(value) ? value.slice(0, maxFieldValueLength) : value;
    count += 1;
  }
  return clamped;
};

const makeBrowserTelemetry = Effect.fn("makeBrowserTelemetry")(function* (
  options?: BrowserTelemetryOptions,
) {
  const transport = yield* BrowserEventTransport;
  const maxBatchSize = Math.min(options?.maxBatchSize ?? 32, maxEventsPerBatch);
  const maxQueueSize = options?.maxQueueSize ?? 256;
  const flushInterval = Duration.fromInputUnsafe(options?.flushInterval ?? "5 seconds");
  const queue = yield* Ref.make<EventQueue>({ events: [], dropped: 0 });

  const emit = (name: string, fields?: WideEventFields): Effect.Effect<void> =>
    Effect.gen(function* () {
      const occurredAt = yield* Clock.currentTimeMillis;
      const event = new BrowserEvent({
        id: crypto.randomUUID(),
        name: name.slice(0, maxEventNameLength),
        occurredAt,
        fields: clampFields(fields ?? {}),
      });
      yield* Ref.update(queue, (state) =>
        state.events.length >= maxQueueSize
          ? { events: [...state.events.slice(1), event], dropped: state.dropped + 1 }
          : { events: [...state.events, event], dropped: state.dropped },
      );
    });

  const flush: Effect.Effect<void, BrowserEventDeliveryError> = Effect.gen(function* () {
    while (true) {
      const batchEvents = yield* Ref.modify(queue, (state) => [
        state.events.slice(0, maxBatchSize),
        { events: state.events.slice(maxBatchSize), dropped: state.dropped },
      ]);
      if (batchEvents.length === 0) {
        return;
      }
      yield* transport.send(new BrowserEventBatch({ version: 1, events: batchEvents })).pipe(
        Effect.tapError(() =>
          Ref.update(queue, (state) => {
            const requeued = [...batchEvents, ...state.events];
            return {
              events: requeued.slice(0, maxQueueSize),
              dropped: state.dropped + Math.max(0, requeued.length - maxQueueSize),
            };
          }),
        ),
      );
    }
  });

  yield* Effect.forkScoped(flush.pipe(Effect.ignore, Effect.delay(flushInterval), Effect.forever));
  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));

  return {
    emit,
    flush: () => flush,
    pending: () => Ref.get(queue).pipe(Effect.map((state) => state.events.length)),
    dropped: () => Ref.get(queue).pipe(Effect.map((state) => state.dropped)),
  };
});

export class BrowserTelemetry extends Context.Service<
  BrowserTelemetry,
  {
    emit(name: string, fields?: WideEventFields): Effect.Effect<void>;
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
