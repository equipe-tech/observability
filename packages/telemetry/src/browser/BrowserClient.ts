import { Predicate } from "effect";
import { browserRequestByteBudget } from "../BrowserEvents.ts";
import { sanitizeBrowserFields, sanitizeEventName } from "../RedactionPolicy.ts";

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
  readonly shutdownTimeoutMs?: number;
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

export class BrowserTelemetryClientShutdownError extends Error {
  readonly code = "OBS_BROWSER_EVENTS_SHUTDOWN_TIMEOUT";
  readonly retryable = true;

  constructor(readonly timeoutMs: number) {
    super(
      `Browser telemetry shutdown exceeded ${timeoutMs} milliseconds. The client aborted active delivery and retained its sanitized batch.`,
    );
    this.name = "BrowserTelemetryClientShutdownError";
  }
}

const defaultEndpoint = "/_telemetry/events";
const defaultMaxBatchSize = 32;
const defaultMaxQueueSize = 256;
const defaultFlushIntervalMs = 5_000;
const defaultShutdownTimeoutMs = 2_000;
const maxBatchSizeLimit = 64;
const fallbackEventName = "browser.event";
const browserFieldValueByteBudget = 2_048;
const textEncoder = new TextEncoder();

export const browserBatchByteLength = (batch: BrowserTelemetryClientBatch): number =>
  textEncoder.encode(JSON.stringify(batch)).byteLength;

const fitStringToByteBudget = (value: string): string => {
  if (textEncoder.encode(value).byteLength <= browserFieldValueByteBudget) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength;
    if (bytes + characterBytes > browserFieldValueByteBudget) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
};

const fitEventToRequestBudget = (
  event: BrowserTelemetryClientEvent,
): BrowserTelemetryClientEvent => {
  const byteBoundedEvent = {
    ...event,
    fields: Object.fromEntries(
      Object.entries(event.fields).map(([key, value]) => [
        key,
        Predicate.isString(value) ? fitStringToByteBudget(value) : value,
      ]),
    ),
  };
  if (
    browserBatchByteLength({ version: 1, events: [byteBoundedEvent] }) <= browserRequestByteBudget
  ) {
    return byteBoundedEvent;
  }
  const fields: { [field: string]: string | number | boolean } = {};
  for (const [key, value] of Object.entries(byteBoundedEvent.fields)) {
    const candidate = { ...fields, [key]: value };
    if (
      browserBatchByteLength({
        version: 1,
        events: [{ ...byteBoundedEvent, fields: candidate }],
      }) <= browserRequestByteBudget
    ) {
      fields[key] = value;
    }
  }
  return { ...byteBoundedEvent, fields };
};

export const normalizePositiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;

const positiveInteger = normalizePositiveInteger;

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
  readonly shutdownTimeoutMs: number;
  readonly transport: BrowserTelemetryClientTransport;
  readonly startTimer: boolean;
};

type ActiveDelivery = {
  readonly events: Array<BrowserTelemetryClientEvent>;
  abandoned: boolean;
};

export class BrowserClientEngine implements BrowserTelemetryClient {
  private events: Array<BrowserTelemetryClientEvent> = [];
  private activeFlush: Promise<void> | undefined;
  private activeDelivery: ActiveDelivery | undefined;
  private readonly activeControllers = new Set<AbortController>();
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
    const sanitizedName = sanitizeEventName(name);
    const event: BrowserTelemetryClientEvent = {
      id: crypto.randomUUID(),
      name: sanitizedName.length === 0 ? fallbackEventName : sanitizedName,
      occurredAt: Date.now(),
      fields: sanitizeBrowserFields(fields),
    };
    if (this.events.length >= this.options.maxQueueSize) {
      this.events.shift();
      this.droppedEvents += 1;
    }
    this.events.push(fitEventToRequestBudget(event));
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
    this.disposal = this.options.disabled ? Promise.resolve() : this.shutdown();
    return this.disposal;
  }

  private async shutdown(): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        for (const controller of this.activeControllers) controller.abort();
        this.abandonActiveDelivery();
        reject(new BrowserTelemetryClientShutdownError(this.options.shutdownTimeoutMs));
      }, this.options.shutdownTimeoutMs);
    });
    try {
      if (this.activeFlush !== undefined) {
        try {
          await Promise.race([this.activeFlush, deadline]);
        } catch (cause) {
          if (cause instanceof BrowserTelemetryClientShutdownError) throw cause;
        }
      }
      await Promise.race([this.flushQueued(true), deadline]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  private abandonActiveDelivery(): void {
    if (this.activeDelivery === undefined || this.activeDelivery.abandoned) return;
    this.activeDelivery.abandoned = true;
    const requeued = [...this.activeDelivery.events, ...this.events];
    this.events = requeued.slice(0, this.options.maxQueueSize);
    this.droppedEvents += Math.max(0, requeued.length - this.options.maxQueueSize);
    this.activeDelivery = undefined;
    this.activeControllers.clear();
    this.activeFlush = undefined;
  }

  private flushQueued(allowDisposed = false): Promise<void> {
    if (this.activeFlush !== undefined) return this.activeFlush;
    const run = async (): Promise<void> => {
      while (this.events.length > 0 && (!this.disposed || allowDisposed)) {
        const batchEvents: Array<BrowserTelemetryClientEvent> = [];
        for (const event of this.events.slice(0, this.options.maxBatchSize)) {
          const candidate = [...batchEvents, event];
          if (
            batchEvents.length > 0 &&
            browserBatchByteLength({ version: 1, events: candidate }) > browserRequestByteBudget
          ) {
            break;
          }
          batchEvents.push(event);
        }
        this.events.splice(0, batchEvents.length);
        const delivery: ActiveDelivery = { events: batchEvents, abandoned: false };
        const controller = new AbortController();
        this.activeDelivery = delivery;
        this.activeControllers.add(controller);
        try {
          await this.options.transport({ version: 1, events: batchEvents }, controller.signal);
          if (delivery.abandoned) return;
        } catch (cause) {
          if (delivery.abandoned) return;
          const requeued = [...batchEvents, ...this.events];
          this.events = requeued.slice(0, this.options.maxQueueSize);
          this.droppedEvents += Math.max(0, requeued.length - this.options.maxQueueSize);
          throw cause;
        } finally {
          this.activeControllers.delete(controller);
          if (this.activeDelivery === delivery) this.activeDelivery = undefined;
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
    shutdownTimeoutMs: positiveInteger(config.shutdownTimeoutMs, defaultShutdownTimeoutMs),
    transport: config.transport ?? fetchTransport(config.endpoint ?? defaultEndpoint),
    startTimer: true,
  });
};
