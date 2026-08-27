import { createStandaloneMetrics } from "./MetricsRuntime.ts";

export type MetricAttributeValue = string | number | boolean;

export interface MetricAttribute {
  readonly key: string;
  readonly value: MetricAttributeValue;
}

export interface InstrumentDefinition {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
}

export interface CounterDefinition extends InstrumentDefinition {}

export interface HistogramDefinition extends InstrumentDefinition {
  readonly boundaries: ReadonlyArray<number>;
}

export interface GaugeObservation {
  readonly value: number;
  readonly attributes?: ReadonlyArray<MetricAttribute>;
}

export type ObservableGaugeCallback = () => ReadonlyArray<GaugeObservation>;

export interface Counter {
  add(value: number, attributes?: ReadonlyArray<MetricAttribute>): void;
}

export interface Histogram {
  record(value: number, attributes?: ReadonlyArray<MetricAttribute>): void;
}

export interface ObservableGaugeRegistration {
  unregister(): void;
  [Symbol.dispose](): void;
}

export type GaugeCollectionFailureCode =
  | "CALLBACK_FAILED"
  | "INVALID_OBSERVATION"
  | "ATTRIBUTE_LIMIT_EXCEEDED"
  | "SERIES_LIMIT_EXCEEDED";

export interface GaugeCollectionFailure {
  readonly instrumentName: string;
  readonly code: GaugeCollectionFailureCode;
  readonly message: string;
}

export interface FlushResult {
  readonly gaugeFailures: ReadonlyArray<GaugeCollectionFailure>;
}

export interface Metrics {
  counter(definition: CounterDefinition): Counter;
  histogram(definition: HistogramDefinition): Histogram;
  observableGauge(
    definition: InstrumentDefinition,
    callback: ObservableGaugeCallback,
  ): ObservableGaugeRegistration;
  flush(): Promise<FlushResult>;
  close(): Promise<FlushResult>;
}

export interface MetricsOptions {
  readonly enabled?: boolean;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly otlpEndpoint: string;
  readonly exportIntervalMilliseconds?: number;
  readonly flushTimeoutMilliseconds?: number;
}

export type MetricsErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INSTRUMENT"
  | "INVALID_MEASUREMENT"
  | "INSTRUMENT_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "EXPORT_FAILED"
  | "FLUSH_TIMED_OUT"
  | "CLOSED";

interface MetricsErrorOptions {
  readonly code: MetricsErrorCode;
  readonly operation: string;
  readonly message: string;
  readonly instrumentName?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class MetricsError extends Error {
  readonly code: MetricsErrorCode;
  readonly operation: string;
  readonly instrumentName?: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(options: MetricsErrorOptions) {
    super(options.message);
    this.name = "MetricsError";
    this.code = options.code;
    this.operation = options.operation;
    if (options.instrumentName !== undefined) {
      this.instrumentName = options.instrumentName;
    }
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

export const createMetrics: (options: MetricsOptions) => Promise<Metrics> = (options) =>
  createStandaloneMetrics(options);
