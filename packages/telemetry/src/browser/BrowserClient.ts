import { sanitizeBrowserEventName, sanitizeBrowserFields } from "../RedactionPolicy.ts";

export type BrowserTelemetryClientFields = {
  readonly [field: string]: string | number | boolean;
};

export type BrowserTelemetryClientEvent = {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: number;
  readonly fields: BrowserTelemetryClientFields;
};

export type BrowserTelemetryClientBatch = {
  readonly version: 1;
  readonly events: ReadonlyArray<BrowserTelemetryClientEvent>;
};

export type BrowserTelemetryClientTransport = (
  batch: BrowserTelemetryClientBatch,
  signal: AbortSignal,
) => Promise<void>;

export type BrowserTelemetryClientConfig = {
  readonly disabled?: boolean;
  readonly endpoint?: string;
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly flushIntervalMs?: number;
  readonly transport?: BrowserTelemetryClientTransport;
};

export type BrowserTelemetryClient = {
  emit(name: string, fields?: BrowserTelemetryClientFields): void;
  flush(): Promise<void>;
  pending(): number;
  dispose(): Promise<void>;
};

export class BrowserTelemetryClientDeliveryError extends Error {
  readonly code = "OBS_BROWSER_EVENTS_DELIVERY_FAILED";

  constructor(
    message: string,
    readonly retryable: boolean,
    options: { readonly cause: unknown },
  ) {
    super(message, options);
    this.name = "BrowserTelemetryClientDeliveryError";
  }
}

const defaultEndpoint = "/_telemetry/events";
const defaultMaxBatchSize = 32;
const defaultMaxQueueSize = 256;
const defaultFlushIntervalMs = 5_000;
const maxBatchSizeLimit = 64;

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;

const fetchTransport =
  (endpoint: string): BrowserTelemetryClientTransport =>
  async (batch, signal) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        keepalive: true,
        signal,
      });
    } catch (cause) {
      throw new BrowserTelemetryClientDeliveryError(
        "The browser events could not be sent. The events stay queued and the next flush retries the same batch.",
        true,
        { cause },
      );
    }
    if (!response.ok) {
      throw new BrowserTelemetryClientDeliveryError(
        `The telemetry endpoint rejected the batch with status ${response.status}. Check the /_telemetry/events route of the project API.`,
        response.status === 429 || response.status >= 500,
        { cause: response.status },
      );
    }
  };

type BrowserClientEngineOptions = {
  readonly disabled: boolean;
  readonly maxBatchSize: number;
  readonly maxQueueSize: number;
  readonly flushIntervalMs: number;
  readonly transport: BrowserTelemetryClientTransport;
  readonly startTimer: boolean;
};

export class BrowserClientEngine implements BrowserTelemetryClient {
  private events: Array<BrowserTelemetryClientEvent> = [];
  private activeFlush: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private droppedEvents = 0;

  constructor(private readonly options: BrowserClientEngineOptions) {
    if (!options.disabled && options.startTimer) {
      this.timer = setInterval(() => {
        this.flush().catch(() => undefined);
      }, options.flushIntervalMs);
    }
  }

  emit(name: string, fields: BrowserTelemetryClientFields = {}): void {
    if (this.options.disabled || this.disposed) return;
    const event: BrowserTelemetryClientEvent = {
      id: crypto.randomUUID(),
      name: sanitizeBrowserEventName(name),
      occurredAt: Date.now(),
      fields: sanitizeBrowserFields(fields),
    };
    if (this.events.length >= this.options.maxQueueSize) {
      this.events.shift();
      this.droppedEvents += 1;
    }
    this.events.push(event);
  }

  flush(): Promise<void> {
    if (this.options.disabled || this.disposed) return Promise.resolve();
    return this.flushQueued();
  }

  pending(): number {
    return this.options.disabled ? 0 : this.events.length;
  }

  dropped(): number {
    return this.droppedEvents;
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.disposal = this.options.disabled
      ? Promise.resolve()
      : (this.activeFlush ?? Promise.resolve()).then(() => this.flushQueued(true));
    return this.disposal;
  }

  private flushQueued(allowDisposed = false): Promise<void> {
    if (this.activeFlush !== undefined) return this.activeFlush;
    const run = async (): Promise<void> => {
      while (this.events.length > 0 && (!this.disposed || allowDisposed)) {
        const batchEvents = this.events.splice(0, this.options.maxBatchSize);
        try {
          const controller = new AbortController();
          await this.options.transport({ version: 1, events: batchEvents }, controller.signal);
        } catch (cause) {
          const requeued = [...batchEvents, ...this.events];
          this.events = requeued.slice(0, this.options.maxQueueSize);
          this.droppedEvents += Math.max(0, requeued.length - this.options.maxQueueSize);
          throw cause;
        }
      }
    };
    this.activeFlush = run().finally(() => {
      this.activeFlush = undefined;
    });
    return this.activeFlush;
  }
}

export const createBrowserTelemetryClient = (
  config: BrowserTelemetryClientConfig = {},
): BrowserTelemetryClient => {
  const maxBatchSize = Math.min(
    positiveInteger(config.maxBatchSize, defaultMaxBatchSize),
    maxBatchSizeLimit,
  );
  return new BrowserClientEngine({
    disabled: config.disabled ?? false,
    maxBatchSize,
    maxQueueSize: positiveInteger(config.maxQueueSize, defaultMaxQueueSize),
    flushIntervalMs: positiveInteger(config.flushIntervalMs, defaultFlushIntervalMs),
    transport: config.transport ?? fetchTransport(config.endpoint ?? defaultEndpoint),
    startTimer: true,
  });
};
