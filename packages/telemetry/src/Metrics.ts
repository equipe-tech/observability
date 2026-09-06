import type { MetricMeasurementErrorCode } from "./contract/MetricContractError.ts";
import type { EnvironmentAliasPolicy, ResourceIdentityField } from "./ResourceIdentity.ts";
import { createStandaloneMetrics } from "./MetricsRuntime.ts";
import type { DataPolicy } from "./policy/DataPolicy.ts";
import type { MetricLabelRejection } from "./policy/MetricLabelPolicy.ts";

export type { MetricLabelRejection } from "./policy/MetricLabelPolicy.ts";

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
  | "SERIES_LIMIT_EXCEEDED"
  | "POLICY_BLOCKED"
  | "CONTRACT_REJECTED";

export interface GaugeCollectionFailure {
  readonly instrumentName: string;
  readonly code: GaugeCollectionFailureCode;
  readonly message: string;
  readonly policyReason?: MetricLabelRejection;
  readonly contractReason?: MetricMeasurementErrorCode;
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
  readonly deploymentEnvironmentAlias?: EnvironmentAliasPolicy | undefined;
  readonly otlpEndpoint: string;
  readonly exportIntervalMilliseconds?: number;
  readonly flushTimeoutMilliseconds?: number;
  readonly policy?: DataPolicy;
}

export type MetricsErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INSTRUMENT"
  | "INVALID_MEASUREMENT"
  | "INSTRUMENT_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "EXPORT_FAILED"
  | "FLUSH_TIMED_OUT"
  | "POLICY_BLOCKED"
  | "CLOSED";

interface MetricsErrorOptions {
  readonly code: MetricsErrorCode;
  readonly operation: string;
  readonly message: string;
  readonly instrumentName?: string;
  readonly attributeKey?: string;
  readonly policyReason?: MetricLabelRejection;
  readonly field?: ResourceIdentityField;
  readonly rule?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class MetricsError extends Error {
  readonly code: MetricsErrorCode;
  readonly operation: string;
  readonly instrumentName?: string;
  readonly attributeKey?: string;
  readonly policyReason?: MetricLabelRejection;
  readonly field?: ResourceIdentityField;
  readonly rule?: string;
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
    if (options.attributeKey !== undefined) {
      this.attributeKey = options.attributeKey;
    }
    if (options.policyReason !== undefined) {
      this.policyReason = options.policyReason;
    }
    if (options.field !== undefined) {
      this.field = options.field;
    }
    if (options.rule !== undefined) {
      this.rule = options.rule;
    }
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

export const createMetrics: (options: MetricsOptions) => Promise<Metrics> = (options) =>
  createStandaloneMetrics(options);
