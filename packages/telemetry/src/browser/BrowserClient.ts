import {
  browserRequestByteBudget,
  maxEventIdLength,
  maxFieldValueLength,
} from "./BrowserEventLimits.ts";
import { sanitizeClientEventName, sanitizeClientFields } from "./ClientPolicy.ts";

export type BrowserTelemetryClientFields = {
  readonly [field: string]: string | number | boolean;
};

export type BrowserTelemetryClientError = {
  readonly type: string;
  readonly message: string;
  readonly retryable: boolean;
};

export type BrowserTraceContext = {
  readonly traceId: string;
  readonly spanId: string;
};

export type BrowserTelemetryClientEvent = {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: number;
  readonly fields: BrowserTelemetryClientFields;
  readonly error?: BrowserTelemetryClientError;
  readonly trace?: BrowserTraceContext;
};

export type BrowserTelemetryClientSpan = BrowserTraceContext & {
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly fields: BrowserTelemetryClientFields;
};

export type BrowserTelemetryClientMetric = {
  readonly name: string;
  readonly value: number;
  readonly occurredAt: number;
  readonly fields: BrowserTelemetryClientFields;
};

export type BrowserTraceHandle = {
  readonly context: BrowserTraceContext;
  readonly end: (fields?: BrowserTelemetryClientFields) => void;
};

export type BrowserCounter = {
  readonly add: (value?: number, fields?: BrowserTelemetryClientFields) => void;
};

export type BrowserTelemetryDefectInput = {
  readonly id?: string;
  readonly name: string;
  readonly error: BrowserTelemetryClientError;
  readonly fields?: BrowserTelemetryClientFields;
};

export type BrowserTelemetryClientResource = {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
};

export type BrowserTelemetryClientBatch = {
  readonly version: 1;
  readonly resource?: BrowserTelemetryClientResource;
  readonly events: ReadonlyArray<BrowserTelemetryClientEvent>;
  readonly spans?: ReadonlyArray<BrowserTelemetryClientSpan>;
  readonly metrics?: ReadonlyArray<BrowserTelemetryClientMetric>;
};

export type BrowserTelemetryClientTransport = (
  batch: BrowserTelemetryClientBatch,
  signal: AbortSignal,
) => Promise<void>;

export type BrowserTelemetryFieldTransform = (
  fields: BrowserTelemetryClientFields,
) => BrowserTelemetryClientFields;

export type BrowserTelemetryClientConfig = {
  readonly disabled?: boolean;
  readonly endpoint?: string;
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
  readonly flushIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly metrics?: boolean;
  readonly resource?: BrowserTelemetryClientResource;
  readonly transport?: BrowserTelemetryClientTransport;
  readonly policy?: BrowserTelemetryFieldTransform;
};

export type BrowserTelemetryClient = {
  emit(name: string, fields?: BrowserTelemetryClientFields, trace?: BrowserTraceContext): void;
  emitDefect(input: BrowserTelemetryDefectInput): void;
  readonly traces: {
    readonly startSpan: (
      name: string,
      fields?: BrowserTelemetryClientFields,
      parent?: BrowserTraceContext,
    ) => BrowserTraceHandle;
  };
  readonly metrics: {
    readonly counter: (name: string) => BrowserCounter;
  };
  flush(): Promise<void>;
  pending(): number;
  dropped(): number;
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
      `Browser telemetry shutdown exceeded ${timeoutMs} milliseconds; pending sanitized events were dropped.`,
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

const boundedOperationalText = (
  value: string | number | boolean | undefined,
  fallback: string,
): string => {
  try {
    return String(value ?? fallback).slice(0, maxFieldValueLength);
  } catch {
    return fallback;
  }
};

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

const fitFieldValueToByteBudget = (value: string | number | boolean): string | number | boolean => {
  try {
    return String(value) === value ? fitStringToByteBudget(value) : value;
  } catch {
    return "[REDACTED]";
  }
};

const fitEventToRequestBudget = (
  event: BrowserTelemetryClientEvent,
): BrowserTelemetryClientEvent => {
  const byteBoundedEvent = {
    ...event,
    fields: Object.fromEntries(
      Object.entries(event.fields).map(([key, value]) => [key, fitFieldValueToByteBudget(value)]),
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
        "Browser delivery failed; sanitized events remain queued.",
        true,
        { cause },
      );
    }
    if (!response.ok) {
      throw new BrowserTelemetryClientDeliveryError(
        `Telemetry returned ${response.status}; verify /_telemetry/events.`,
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
  readonly metrics: boolean;
  readonly resource: BrowserTelemetryClientResource | undefined;
  readonly transport: BrowserTelemetryClientTransport;
  readonly policy: BrowserTelemetryFieldTransform | undefined;
  readonly startTimer: boolean;
};

type ActiveDelivery = {
  readonly batch: BrowserTelemetryClientBatch;
  abandoned: boolean;
};

type ActiveBrowserSpan = BrowserTraceContext & {
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: number;
  readonly fields: BrowserTelemetryClientFields;
};

const randomHex = (length: number): string => {
  let value = "";
  while (value.length < length) value += crypto.randomUUID().replaceAll("-", "");
  return value.slice(0, length);
};

export class BrowserClientEngine implements BrowserTelemetryClient {
  private events: Array<BrowserTelemetryClientEvent> = [];
  private spans: Array<BrowserTelemetryClientSpan> = [];
  private metricPoints: Array<BrowserTelemetryClientMetric> = [];
  private activeSpans = new Map<string, ActiveBrowserSpan>();
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

  readonly traces = {
    startSpan: (
      name: string,
      fields: BrowserTelemetryClientFields = {},
      parent?: BrowserTraceContext,
    ): BrowserTraceHandle => {
      const context = { traceId: parent?.traceId ?? randomHex(32), spanId: randomHex(16) };
      const startedAt = Date.now();
      const active: ActiveBrowserSpan = {
        ...context,
        name: sanitizeClientEventName(name) || fallbackEventName,
        startedAt,
        fields: this.sanitizeFields(fields),
      };
      if (parent !== undefined) Object.assign(active, { parentSpanId: parent.spanId });
      if (!this.options.disabled && !this.disposed) this.activeSpans.set(context.spanId, active);
      return {
        context,
        end: (endFields = {}) => {
          const current = this.activeSpans.get(context.spanId);
          if (current === undefined || this.options.disabled || this.disposed) return;
          this.activeSpans.delete(context.spanId);
          this.enqueueSpan({
            ...current,
            endedAt: Date.now(),
            fields: this.sanitizeFields({ ...current.fields, ...endFields }),
          });
        },
      };
    },
  };

  readonly metrics = {
    counter: (name: string): BrowserCounter => ({
      add: (value = 1, fields = {}) => {
        if (
          this.options.disabled ||
          this.disposed ||
          !this.options.metrics ||
          !Number.isFinite(value) ||
          value < 0
        ) {
          return;
        }
        this.enqueueMetric({
          name: sanitizeClientEventName(name) || fallbackEventName,
          value,
          occurredAt: Date.now(),
          fields: this.sanitizeFields(fields),
        });
      },
    }),
  };

  emit(name: string, fields: BrowserTelemetryClientFields = {}, trace?: BrowserTraceContext): void {
    if (this.options.disabled || this.disposed) return;
    const sanitizedName = sanitizeClientEventName(name);
    const event = {
      id: crypto.randomUUID(),
      name: sanitizedName.length === 0 ? fallbackEventName : sanitizedName,
      occurredAt: Date.now(),
      fields: this.sanitizeFields(fields),
    };
    this.enqueue(trace === undefined ? event : { ...event, trace });
  }

  emitDefect(input: BrowserTelemetryDefectInput): void {
    if (this.options.disabled || this.disposed) return;
    const sanitizedName = sanitizeClientEventName(input.name);
    const id = input.id ?? crypto.randomUUID().replaceAll("-", "");
    const operationalError = this.sanitizeFields({
      "error.type": input.error.type,
      "error.message": input.error.message,
    });
    const type = operationalError["error.type"];
    const message = operationalError["error.message"];
    this.enqueue({
      id: id.slice(0, maxEventIdLength),
      name: sanitizedName.length === 0 ? fallbackEventName : sanitizedName,
      occurredAt: Date.now(),
      fields: this.sanitizeFields(input.fields ?? {}),
      error: {
        type: boundedOperationalText(type, "Error"),
        message: boundedOperationalText(message, ""),
        retryable: input.error.retryable,
      },
    });
  }

  private sanitizeFields(fields: BrowserTelemetryClientFields): BrowserTelemetryClientFields {
    if (this.options.policy === undefined) return sanitizeClientFields(fields);
    return this.options.policy(fields);
  }

  private batchWithResource(batch: BrowserTelemetryClientBatch): BrowserTelemetryClientBatch {
    return this.options.resource === undefined
      ? batch
      : { ...batch, resource: this.options.resource };
  }

  private enqueue(event: BrowserTelemetryClientEvent): void {
    const fitted = fitEventToRequestBudget(event);
    if (
      browserBatchByteLength(this.batchWithResource({ version: 1, events: [fitted] })) >
      browserRequestByteBudget
    ) {
      this.droppedEvents += 1;
      return;
    }
    this.ensureQueueCapacity();
    this.events.push(fitted);
  }

  private enqueueSpan(span: BrowserTelemetryClientSpan): void {
    const fitted = { ...span, fields: this.sanitizeFields(span.fields) };
    if (
      browserBatchByteLength(this.batchWithResource({ version: 1, events: [], spans: [fitted] })) >
      browserRequestByteBudget
    ) {
      this.droppedEvents += 1;
      return;
    }
    this.ensureQueueCapacity();
    this.spans.push(fitted);
  }

  private enqueueMetric(metric: BrowserTelemetryClientMetric): void {
    const fitted = { ...metric, fields: this.sanitizeFields(metric.fields) };
    if (
      browserBatchByteLength(
        this.batchWithResource({ version: 1, events: [], metrics: [fitted] }),
      ) > browserRequestByteBudget
    ) {
      this.droppedEvents += 1;
      return;
    }
    this.ensureQueueCapacity();
    this.metricPoints.push(fitted);
  }

  private ensureQueueCapacity(): void {
    if (this.pending() < this.options.maxQueueSize) return;
    if (this.events.length > 0) this.events.shift();
    else if (this.spans.length > 0) this.spans.shift();
    else this.metricPoints.shift();
    this.droppedEvents += 1;
  }

  flush(): Promise<void> {
    if (this.options.disabled || this.disposed) return Promise.resolve();
    return this.flushQueued();
  }

  pending(): number {
    return this.options.disabled
      ? 0
      : this.events.length + this.spans.length + this.metricPoints.length;
  }

  dropped(): number {
    return this.droppedEvents;
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    for (const span of this.activeSpans.values()) {
      this.enqueueSpan({
        ...span,
        endedAt: Date.now(),
        fields: this.sanitizeFields({ ...span.fields, "span.forced_end": true }),
      });
    }
    this.activeSpans.clear();
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.disposal = this.options.disabled
      ? Promise.resolve()
      : this.shutdown().catch((cause) => {
          this.dropPending();
          throw cause;
        });
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
    this.events = [...this.activeDelivery.batch.events, ...this.events];
    this.spans = [...(this.activeDelivery.batch.spans ?? []), ...this.spans];
    this.metricPoints = [...(this.activeDelivery.batch.metrics ?? []), ...this.metricPoints];
    this.activeDelivery = undefined;
    this.activeControllers.clear();
    this.activeFlush = undefined;
  }

  private dropPending(): void {
    this.droppedEvents += this.pending();
    this.events.length = 0;
    this.spans.length = 0;
    this.metricPoints.length = 0;
  }

  private flushQueued(allowDisposed = false): Promise<void> {
    if (this.activeFlush !== undefined) return this.activeFlush;
    const run = async (): Promise<void> => {
      while (this.pending() > 0 && (!this.disposed || allowDisposed)) {
        const batchEvents: Array<BrowserTelemetryClientEvent> = [];
        const batchSpans: Array<BrowserTelemetryClientSpan> = [];
        const batchMetrics: Array<BrowserTelemetryClientMetric> = [];
        const candidateBatch = (): BrowserTelemetryClientBatch => {
          const batch = {
            version: 1 as const,
            events: batchEvents,
            spans: batchSpans,
            metrics: batchMetrics,
          };
          return this.batchWithResource(batch);
        };
        const correlatedEvent = this.events.find((event) => event.trace !== undefined);
        if (correlatedEvent?.trace !== undefined) {
          const traceId = correlatedEvent.trace.traceId;
          const correlatedSpans = this.spans.filter((span) => span.traceId === traceId);
          if (correlatedSpans.length === 0) return;
          const correlatedEvents = this.events.filter((event) => event.trace?.traceId === traceId);
          batchSpans.push(...correlatedSpans);
          batchEvents.push(...correlatedEvents);
          if (
            batchSpans.length > maxBatchSizeLimit ||
            batchEvents.length > maxBatchSizeLimit ||
            browserBatchByteLength(candidateBatch()) > browserRequestByteBudget
          ) {
            this.spans = this.spans.filter((span) => span.traceId !== traceId);
            this.events = this.events.filter((event) => event.trace?.traceId !== traceId);
            this.droppedEvents += correlatedSpans.length + correlatedEvents.length;
            continue;
          }
          this.spans = this.spans.filter((span) => span.traceId !== traceId);
          this.events = this.events.filter((event) => event.trace?.traceId !== traceId);
        }
        while (batchEvents.length < this.options.maxBatchSize && this.events.length > 0) {
          const event = this.events[0];
          if (event === undefined || event.trace !== undefined) break;
          batchEvents.push(event);
          if (browserBatchByteLength(candidateBatch()) > browserRequestByteBudget) {
            batchEvents.pop();
            break;
          }
          this.events.shift();
        }
        while (
          batchEvents.length + batchSpans.length < this.options.maxBatchSize &&
          this.spans.length > 0
        ) {
          const span = this.spans[0];
          if (span === undefined) break;
          batchSpans.push(span);
          if (browserBatchByteLength(candidateBatch()) > browserRequestByteBudget) {
            batchSpans.pop();
            break;
          }
          this.spans.shift();
        }
        while (
          batchEvents.length + batchSpans.length + batchMetrics.length <
            this.options.maxBatchSize &&
          this.metricPoints.length > 0
        ) {
          const metric = this.metricPoints[0];
          if (metric === undefined) break;
          batchMetrics.push(metric);
          if (browserBatchByteLength(candidateBatch()) > browserRequestByteBudget) {
            batchMetrics.pop();
            break;
          }
          this.metricPoints.shift();
        }
        let batch = this.batchWithResource({ version: 1, events: batchEvents });
        if (batchSpans.length > 0 && batchMetrics.length > 0) {
          batch = { ...batch, spans: batchSpans, metrics: batchMetrics };
        } else if (batchSpans.length > 0) {
          batch = { ...batch, spans: batchSpans };
        } else if (batchMetrics.length > 0) {
          batch = { ...batch, metrics: batchMetrics };
        }
        const delivery: ActiveDelivery = { batch, abandoned: false };
        const controller = new AbortController();
        this.activeDelivery = delivery;
        this.activeControllers.add(controller);
        try {
          await this.options.transport(batch, controller.signal);
          if (delivery.abandoned) return;
        } catch (cause) {
          if (delivery.abandoned) return;
          if (cause instanceof BrowserTelemetryClientDeliveryError && !cause.retryable) {
            this.droppedEvents += batchEvents.length + batchSpans.length + batchMetrics.length;
          } else {
            this.events = [...batchEvents, ...this.events];
            this.spans = [...batchSpans, ...this.spans];
            this.metricPoints = [...batchMetrics, ...this.metricPoints];
            while (this.pending() > this.options.maxQueueSize) {
              if (this.metricPoints.length > 0) this.metricPoints.pop();
              else if (this.spans.length > 0) this.spans.pop();
              else this.events.pop();
              this.droppedEvents += 1;
            }
          }
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
    normalizePositiveInteger(config.maxBatchSize, defaultMaxBatchSize),
    maxBatchSizeLimit,
  );
  return new BrowserClientEngine({
    disabled: config.disabled ?? false,
    maxBatchSize,
    maxQueueSize: normalizePositiveInteger(config.maxQueueSize, defaultMaxQueueSize),
    flushIntervalMs: normalizePositiveInteger(config.flushIntervalMs, defaultFlushIntervalMs),
    shutdownTimeoutMs: normalizePositiveInteger(config.shutdownTimeoutMs, defaultShutdownTimeoutMs),
    metrics: config.metrics ?? false,
    resource: config.resource,
    transport: config.transport ?? fetchTransport(config.endpoint ?? defaultEndpoint),
    policy: config.policy,
    startTimer: true,
  });
};
