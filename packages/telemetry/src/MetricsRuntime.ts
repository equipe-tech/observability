import { Context, Effect, Layer, Metric, Option, Predicate, Result, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { OtlpExporter } from "effect/unstable/observability";
import type {
  Counter,
  CounterDefinition,
  FlushResult,
  GaugeCollectionFailure,
  GaugeObservation,
  Histogram,
  HistogramDefinition,
  InstrumentDefinition,
  MetricAttribute,
  MetricAttributeValue,
  Metrics,
  MetricsOptions,
  ObservableGaugeCallback,
  ObservableGaugeRegistration,
} from "./Metrics.ts";
import { MetricsError } from "./Metrics.ts";
import type { ResourceIdentity } from "./ResourceIdentity.ts";
import {
  EnvironmentAliasPolicy as EnvironmentAliasPolicySchema,
  parseResourceIdentity,
  serviceResourceAttributes,
} from "./ResourceIdentity.ts";
import type { TelemetryConfig } from "./TelemetryConfig.ts";
import { baseDataPolicy, type DataPolicy } from "./policy/DataPolicy.ts";
import { metricLabelRejection, type MetricLabelRejection } from "./policy/MetricLabelPolicy.ts";

const instrumentNamePattern = /^[A-Za-z][A-Za-z0-9_.\-/]{0,254}$/;
const unitPattern = /^(?:1|%|[A-Za-z][A-Za-z0-9]*(?:[./*^][A-Za-z0-9]+)*)$/;
const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
};
const maximumInstruments = 100;
const maximumInstrumentSeries = 1_000;
const maximumAttributeCardinality = 100;
const maximumRuntimeSeries = 10_000;
const maximumAttributes = 16;
const maximumCallbacks = 16;
const maximumObservations = 100;

const MetricAttributeInput = Schema.Struct({
  key: Schema.String,
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
});
const MetricAttributesInput = Schema.Array(MetricAttributeInput);
const InstrumentDefinitionInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  unit: Schema.String,
});
const HistogramDefinitionInput = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  unit: Schema.String,
  boundaries: Schema.Array(Schema.Number),
});
const GaugeObservationsInput = Schema.Array(
  Schema.Struct({
    value: Schema.Number,
    attributes: MetricAttributesInput.pipe(Schema.optionalKey),
  }),
);
const MetricsOptionsInput = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optionalKey),
  serviceName: Schema.String,
  serviceVersion: Schema.String,
  environment: Schema.String,
  deploymentEnvironmentAlias: EnvironmentAliasPolicySchema.pipe(Schema.optionalKey),
  otlpEndpoint: Schema.String,
  exportIntervalMilliseconds: Schema.Number.pipe(Schema.optionalKey),
  flushTimeoutMilliseconds: Schema.Number.pipe(Schema.optionalKey),
});

const decodeMetricAttributes = Schema.decodeUnknownSync(MetricAttributesInput);
const decodeInstrumentDefinition = Schema.decodeUnknownSync(InstrumentDefinitionInput);
const decodeHistogramDefinition = Schema.decodeUnknownSync(HistogramDefinitionInput);
const decodeGaugeObservations = Schema.decodeUnknownSync(GaugeObservationsInput);
const decodeMetricsOptions = Schema.decodeUnknownSync(MetricsOptionsInput);

interface NormalizedOptions {
  readonly enabled: boolean;
  readonly identity: ResourceIdentity;
  readonly metricsEndpoint: string;
  readonly exportIntervalMilliseconds: number;
  readonly flushTimeoutMilliseconds: number;
  readonly poolKey: string;
  readonly policy: DataPolicy;
  readonly resourceAttributes: ReadonlyMap<string, string>;
}

interface NormalizedDefinition {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
}

interface NormalizedHistogramDefinition extends NormalizedDefinition {
  readonly boundaries: ReadonlyArray<number>;
}

interface NormalizedAttribute {
  readonly key: string;
  readonly value: MetricAttributeValue;
}

interface NormalizedAttributes {
  readonly identity: string;
  readonly values: ReadonlyArray<NormalizedAttribute>;
}

interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: number;
  readonly doubleValue?: number;
}

interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

interface OtlpNumberDataPoint {
  readonly attributes: ReadonlyArray<OtlpKeyValue>;
  readonly startTimeUnixNano: string;
  readonly timeUnixNano: string;
  readonly asDouble?: number;
  readonly asInt?: number;
}

interface OtlpHistogramDataPoint {
  readonly attributes: ReadonlyArray<OtlpKeyValue>;
  readonly startTimeUnixNano: string;
  readonly timeUnixNano: string;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly explicitBounds: ReadonlyArray<number>;
  readonly bucketCounts: ReadonlyArray<number>;
}

interface OtlpSum {
  readonly aggregationTemporality: 2;
  readonly isMonotonic: boolean;
  readonly dataPoints: Array<OtlpNumberDataPoint>;
}

interface OtlpGauge {
  readonly dataPoints: Array<OtlpNumberDataPoint>;
}

interface OtlpHistogram {
  readonly aggregationTemporality: 2;
  readonly dataPoints: Array<OtlpHistogramDataPoint>;
}

interface OtlpMetric {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly sum?: OtlpSum;
  readonly gauge?: OtlpGauge;
  readonly histogram?: OtlpHistogram;
}

interface MetricsPayload {
  readonly resourceMetrics: ReadonlyArray<{
    readonly resource: {
      readonly attributes: ReadonlyArray<OtlpKeyValue>;
      readonly droppedAttributesCount: number;
    };
    readonly scopeMetrics: ReadonlyArray<{
      readonly scope: { readonly name: string };
      readonly metrics: ReadonlyArray<OtlpMetric>;
    }>;
  }>;
}

interface CounterSeries {
  readonly attributes: NormalizedAttributes;
  value: number;
}

interface HistogramSeries {
  readonly attributes: NormalizedAttributes;
  count: number;
  sum: number;
  min: number;
  max: number;
  readonly bucketCounts: Array<number>;
}

interface GaugeCallbackState {
  readonly id: number;
  readonly leaseId: number;
  readonly callback: ObservableGaugeCallback;
}

interface CounterEntry {
  readonly kind: "counter";
  readonly definition: NormalizedDefinition;
  readonly leases: Set<number>;
  readonly residualSeries: Map<string, CounterSeries>;
  readonly seriesByLease: Map<number, Map<string, CounterSeries>>;
  readonly lifetimeSeries: Set<string>;
}

interface HistogramEntry {
  readonly kind: "histogram";
  readonly definition: NormalizedHistogramDefinition;
  readonly leases: Set<number>;
  readonly residualSeries: Map<string, HistogramSeries>;
  readonly seriesByLease: Map<number, Map<string, HistogramSeries>>;
  readonly lifetimeSeries: Set<string>;
}

interface GaugeEntry {
  readonly kind: "gauge";
  readonly definition: NormalizedDefinition;
  readonly leases: Set<number>;
  readonly callbacks: Map<number, GaugeCallbackState>;
  readonly lifetimeSeries: Set<string>;
}

type CatalogEntry = CounterEntry | HistogramEntry | GaugeEntry;

type MetricsTransport = (payload: MetricsPayload, signal: AbortSignal) => Promise<void>;

type MetricsTransportKind = "fetch" | "layer";

interface MetricsTransportBinding {
  readonly kind: MetricsTransportKind;
  readonly send: MetricsTransport;
}

interface RuntimeLease {
  readonly leaseId: number;
  readonly state: MetricsRuntimeState;
}

const metricError = (
  code: MetricsError["code"],
  operation: string,
  message: string,
  instrumentName: string | undefined,
  retryable: boolean,
  cause?: unknown,
  attributeKey?: string,
  policyReason?: MetricLabelRejection,
): MetricsError => {
  const options: {
    code: MetricsError["code"];
    operation: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
    attributeKey?: string;
    policyReason?: MetricLabelRejection;
  } = { code, operation, message, retryable };
  if (cause !== undefined) options.cause = cause;
  if (attributeKey !== undefined) options.attributeKey = attributeKey;
  if (policyReason !== undefined) options.policyReason = policyReason;
  if (instrumentName === undefined) {
    return new MetricsError(options);
  }
  return new MetricsError({ ...options, instrumentName });
};

const parseOptions = (input: MetricsOptions): NormalizedOptions => {
  const policy = input.policy ?? baseDataPolicy;
  let options: typeof MetricsOptionsInput.Type;
  try {
    options = decodeMetricsOptions(input);
  } catch (cause) {
    throw metricError(
      "INVALID_CONFIGURATION",
      "createMetrics",
      "Metrics configuration is invalid. Provide valid service metadata and an HTTP OTLP endpoint.",
      undefined,
      false,
      cause,
    );
  }
  const parsedIdentity = Effect.runSync(
    Effect.result(
      parseResourceIdentity({
        serviceName: options.serviceName,
        serviceVersion: options.serviceVersion,
        environment: options.environment,
        instance: Option.none(),
      }),
    ),
  );
  if (Result.isFailure(parsedIdentity)) {
    const failure = parsedIdentity.failure;
    throw new MetricsError({
      code: "INVALID_CONFIGURATION",
      operation: "createMetrics",
      message: failure.message,
      field: failure.field,
      rule: failure.rule,
      retryable: false,
      cause: failure,
    });
  }
  const identity: ResourceIdentity = parsedIdentity.success;
  let endpoint: URL;
  try {
    endpoint = new URL(options.otlpEndpoint);
  } catch (cause) {
    throw metricError(
      "INVALID_CONFIGURATION",
      "createMetrics",
      "Metrics configuration is invalid. Set otlpEndpoint to an HTTP or HTTPS URL without credentials.",
      undefined,
      false,
      cause,
    );
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  ) {
    throw metricError(
      "INVALID_CONFIGURATION",
      "createMetrics",
      "Metrics configuration is invalid. Set otlpEndpoint to an HTTP or HTTPS URL without credentials.",
      undefined,
      false,
    );
  }
  const exportIntervalMilliseconds = options.exportIntervalMilliseconds ?? 10_000;
  const flushTimeoutMilliseconds = options.flushTimeoutMilliseconds ?? 3_000;
  if (
    !Number.isSafeInteger(exportIntervalMilliseconds) ||
    exportIntervalMilliseconds < 1 ||
    !Number.isSafeInteger(flushTimeoutMilliseconds) ||
    flushTimeoutMilliseconds < 1
  ) {
    throw metricError(
      "INVALID_CONFIGURATION",
      "createMetrics",
      "Metrics configuration is invalid. Export and flush intervals must be positive safe integer milliseconds.",
      undefined,
      false,
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/metrics`;
  endpoint.search = "";
  endpoint.hash = "";
  const enabled = options.enabled ?? true;
  const policyKey = JSON.stringify([
    Array.from(policy.attributes.entries()),
    policy.blockedKeys.map((pattern) => [pattern.source, pattern.flags]),
    policy.blockedValuePatterns.map((pattern) => [pattern.source, pattern.flags]),
  ]);
  const environmentAlias = options.deploymentEnvironmentAlias ?? "omitted";
  const poolKey = JSON.stringify([
    endpoint.toString(),
    options.serviceName,
    options.serviceVersion,
    options.environment,
    options.deploymentEnvironmentAlias ?? "omitted",
    exportIntervalMilliseconds,
    flushTimeoutMilliseconds,
    policyKey,
  ]);
  return {
    enabled,
    identity,
    metricsEndpoint: endpoint.toString(),
    exportIntervalMilliseconds,
    flushTimeoutMilliseconds,
    poolKey,
    policy,
    resourceAttributes: new Map(
      Object.entries(serviceResourceAttributes(identity, environmentAlias)),
    ),
  };
};

const parseDefinition = (input: InstrumentDefinition, operation: string): NormalizedDefinition => {
  let definition: typeof InstrumentDefinitionInput.Type;
  try {
    definition = decodeInstrumentDefinition(input);
  } catch (cause) {
    throw metricError(
      "INVALID_INSTRUMENT",
      operation,
      "Metric instrument definition is invalid. Provide a valid name, description, and unit.",
      undefined,
      false,
      cause,
    );
  }
  if (
    !instrumentNamePattern.test(definition.name) ||
    definition.description.length < 1 ||
    definition.description.length > 1_024 ||
    containsControlCharacter(definition.description) ||
    definition.unit.length > 63 ||
    !unitPattern.test(definition.unit)
  ) {
    throw metricError(
      "INVALID_INSTRUMENT",
      operation,
      `Metric instrument "${definition.name}" is invalid. Check its name, description, and unit.`,
      definition.name,
      false,
    );
  }
  return definition;
};

const parseHistogramDefinition = (input: HistogramDefinition): NormalizedHistogramDefinition => {
  let definition: typeof HistogramDefinitionInput.Type;
  try {
    definition = decodeHistogramDefinition(input);
  } catch (cause) {
    throw metricError(
      "INVALID_INSTRUMENT",
      "histogram",
      "Histogram definition is invalid. Provide a valid definition and finite boundaries.",
      undefined,
      false,
      cause,
    );
  }
  const common = parseDefinition(definition, "histogram");
  if (definition.boundaries.length < 1 || definition.boundaries.length > 50) {
    throw metricError(
      "INVALID_INSTRUMENT",
      "histogram",
      `Histogram "${definition.name}" must have between 1 and 50 boundaries.`,
      definition.name,
      false,
    );
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const boundary of definition.boundaries) {
    if (!Number.isFinite(boundary) || boundary <= previous) {
      throw metricError(
        "INVALID_INSTRUMENT",
        "histogram",
        `Histogram "${definition.name}" boundaries must be finite and strictly increasing.`,
        definition.name,
        false,
      );
    }
    previous = boundary;
  }
  return { ...common, boundaries: [...definition.boundaries] };
};

const attributeIdentity = (value: MetricAttributeValue): string => {
  if (Predicate.isString(value)) {
    return `s:${JSON.stringify(value)}`;
  }
  if (Predicate.isBoolean(value)) {
    return value ? "b:1" : "b:0";
  }
  return `n:${Object.is(value, -0) ? 0 : value}`;
};

const parseAttributes = (
  input: ReadonlyArray<MetricAttribute> | undefined,
  operation: string,
  instrumentName: string,
  policy: DataPolicy,
): NormalizedAttributes => {
  let attributes: ReadonlyArray<typeof MetricAttributeInput.Type>;
  try {
    attributes = decodeMetricAttributes(input ?? []);
  } catch (cause) {
    throw metricError(
      "INVALID_MEASUREMENT",
      operation,
      `Metric "${instrumentName}" attributes are invalid. Use bounded scalar attributes.`,
      instrumentName,
      false,
      cause,
    );
  }
  if (attributes.length > maximumAttributes) {
    throw metricError(
      "LIMIT_EXCEEDED",
      operation,
      `Metric "${instrumentName}" exceeds the ${maximumAttributes}-attribute limit.`,
      instrumentName,
      false,
    );
  }
  const keys = new Set<string>();
  const normalized: Array<NormalizedAttribute> = [];
  for (const attribute of attributes) {
    const numberIsInvalid =
      Predicate.isNumber(attribute.value) && !Number.isFinite(attribute.value);
    if (
      attribute.key.length > 128 ||
      !instrumentNamePattern.test(attribute.key) ||
      attribute.key === "unit" ||
      attribute.key === "time_unit" ||
      attribute.key === "service.instance.id" ||
      keys.has(attribute.key) ||
      numberIsInvalid
    ) {
      throw metricError(
        "INVALID_MEASUREMENT",
        operation,
        `Metric "${instrumentName}" attributes are invalid. Use unique bounded keys and finite scalar values.`,
        instrumentName,
        false,
      );
    }
    const rejection = metricLabelRejection(policy, attribute.key, attribute.value);
    if (rejection !== undefined) {
      throw metricError(
        "POLICY_BLOCKED",
        operation,
        `Metric "${instrumentName}" contains a label blocked by the data policy. Remove the label before recording.`,
        instrumentName,
        false,
        undefined,
        undefined,
        rejection,
      );
    }
    keys.add(attribute.key);
    normalized.push({
      key: attribute.key,
      value:
        Predicate.isNumber(attribute.value) && Object.is(attribute.value, -0) ? 0 : attribute.value,
    });
  }
  normalized.sort((left, right) => left.key.localeCompare(right.key));
  return {
    identity: normalized
      .map((attribute) => `${attribute.key}=${attributeIdentity(attribute.value)}`)
      .join("|"),
    values: normalized,
  };
};

const attributesToOtlp = (
  attributes: ReadonlyArray<NormalizedAttribute>,
): ReadonlyArray<OtlpKeyValue> =>
  attributes.map((attribute) => {
    if (Predicate.isString(attribute.value)) {
      return { key: attribute.key, value: { stringValue: attribute.value } };
    }
    if (Predicate.isBoolean(attribute.value)) {
      return { key: attribute.key, value: { boolValue: attribute.value } };
    }
    if (Number.isInteger(attribute.value)) {
      return { key: attribute.key, value: { intValue: attribute.value } };
    }
    return { key: attribute.key, value: { doubleValue: attribute.value } };
  });

const directAttributesToOtlp = (
  attributes: Metric.Metric.AttributeSet | undefined,
  instrumentName: string,
  policy: DataPolicy,
): {
  readonly values: ReadonlyArray<OtlpKeyValue>;
  readonly failures: ReadonlyArray<GaugeCollectionFailure>;
} => {
  if (attributes === undefined) {
    return { values: [], failures: [] };
  }
  const values: Array<OtlpKeyValue> = [];
  const failures: Array<GaugeCollectionFailure> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "unit" || key === "time_unit") continue;
    if (key === "service.instance.id") {
      throw metricError(
        "EXPORT_FAILED",
        "flush",
        `Metric "${instrumentName}" cannot use service.instance.id as a datapoint attribute. Remove the reserved key before retrying.`,
        instrumentName,
        false,
      );
    }
    const rejection = metricLabelRejection(policy, key, value);
    if (rejection !== undefined) {
      failures.push({
        instrumentName,
        code: "POLICY_BLOCKED",
        message: `Metric "${instrumentName}" dropped a label blocked by the data policy.`,
        policyReason: rejection,
      });
      continue;
    }
    values.push({ key, value: { stringValue: value } });
  }
  return { values, failures };
};

const sameDefinition = (
  entry: CatalogEntry,
  kind: CatalogEntry["kind"],
  definition: NormalizedDefinition,
  boundaries: ReadonlyArray<number> | undefined,
): boolean => {
  if (
    entry.kind !== kind ||
    entry.definition.name !== definition.name ||
    entry.definition.description !== definition.description ||
    entry.definition.unit !== definition.unit
  ) {
    return false;
  }
  if (entry.kind !== "histogram") {
    return boundaries === undefined;
  }
  if (boundaries === undefined || entry.definition.boundaries.length !== boundaries.length) {
    return false;
  }
  return entry.definition.boundaries.every((boundary, index) => boundary === boundaries[index]);
};

const histogramBucketIndex = (boundaries: ReadonlyArray<number>, value: number): number => {
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index];
    if (boundary !== undefined && value <= boundary) {
      return index;
    }
  }
  return boundaries.length;
};

const nanosNow = (): string => String(BigInt(Date.now()) * 1_000_000n);

class MetricsRuntimeState {
  readonly registry = new Map();
  readonly policy: DataPolicy;
  readonly directContext = Context.make(Metric.MetricRegistry, this.registry);
  readonly catalog = new Map<string, CatalogEntry>();
  readonly runtimeLifetimeSeries = new Set<string>();
  readonly lifetimeSeriesByInstrument = new Map<string, Set<string>>();
  readonly lifetimeValuesByInstrumentKey = new Map<string, Set<string>>();
  readonly lifetimeInstrumentNames = new Set<string>();
  private readonly leases = new Set<number>();
  private readonly transports = new Map<number, MetricsTransportBinding>();
  private readonly options: NormalizedOptions;
  private readonly removeFromPool: () => void;
  private readonly startTimeUnixNano = nanosNow();
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextLeaseId = 1;
  private nextCallbackId = 1;
  private referenceCount = 0;
  private periodicFailureActive = false;

  constructor(options: NormalizedOptions, removeFromPool: () => void) {
    this.options = options;
    this.policy = options.policy;
    this.removeFromPool = removeFromPool;
    this.timer = setInterval(() => {
      this.scheduleExport(this.options.flushTimeoutMilliseconds).then(
        (result) => this.recordPeriodicOutcome(result.gaugeFailures.length > 0),
        () => this.recordPeriodicOutcome(true),
      );
    }, options.exportIntervalMilliseconds);
    this.timer.unref?.();
  }

  acquire(transport: MetricsTransportBinding): RuntimeLease {
    const leaseId = this.nextLeaseId++;
    this.leases.add(leaseId);
    this.transports.set(leaseId, transport);
    this.referenceCount++;
    return { leaseId, state: this };
  }

  nextGaugeCallbackId(): number {
    return this.nextCallbackId++;
  }

  flush(timeoutMilliseconds: number): Promise<FlushResult> {
    return this.scheduleExport(timeoutMilliseconds);
  }

  async closeLease(leaseId: number, timeoutMilliseconds: number): Promise<FlushResult> {
    let result: FlushResult;
    let failure: MetricsError | undefined;
    try {
      result = await this.scheduleExport(timeoutMilliseconds);
    } catch (cause) {
      result = { gaugeFailures: [] };
      failure =
        cause instanceof MetricsError
          ? cause
          : metricError(
              "EXPORT_FAILED",
              "close",
              "The final metrics export failed. The runtime lease was still released.",
              undefined,
              true,
              cause,
            );
    }
    this.removeLeaseState(leaseId);
    this.leases.delete(leaseId);
    this.transports.delete(leaseId);
    this.referenceCount--;
    if (this.referenceCount === 0) {
      if (this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      this.removeFromPool();
    }
    if (failure !== undefined) {
      throw failure;
    }
    return result;
  }

  registerCounter(leaseId: number, definition: NormalizedDefinition): CounterEntry {
    const existing = this.catalog.get(definition.name);
    if (existing !== undefined) {
      if (
        existing.kind !== "counter" ||
        !sameDefinition(existing, "counter", definition, undefined)
      ) {
        throw this.instrumentConflict("counter", definition.name);
      }
      existing.leases.add(leaseId);
      return existing;
    }
    this.assertInstrumentCapacity(definition.name);
    const entry: CounterEntry = {
      kind: "counter",
      definition,
      leases: new Set([leaseId]),
      residualSeries: new Map(),
      seriesByLease: new Map(),
      lifetimeSeries: this.lifetimeSeriesFor(definition.name),
    };
    this.catalog.set(definition.name, entry);
    return entry;
  }

  registerHistogram(leaseId: number, definition: NormalizedHistogramDefinition): HistogramEntry {
    const existing = this.catalog.get(definition.name);
    if (existing !== undefined) {
      if (
        existing.kind !== "histogram" ||
        !sameDefinition(existing, "histogram", definition, definition.boundaries)
      ) {
        throw this.instrumentConflict("histogram", definition.name);
      }
      existing.leases.add(leaseId);
      return existing;
    }
    this.assertInstrumentCapacity(definition.name);
    const entry: HistogramEntry = {
      kind: "histogram",
      definition,
      leases: new Set([leaseId]),
      residualSeries: new Map(),
      seriesByLease: new Map(),
      lifetimeSeries: this.lifetimeSeriesFor(definition.name),
    };
    this.catalog.set(definition.name, entry);
    return entry;
  }

  registerGauge(
    leaseId: number,
    definition: NormalizedDefinition,
    callback: ObservableGaugeCallback,
  ): { readonly entry: GaugeEntry; readonly callbackId: number } {
    const existing = this.catalog.get(definition.name);
    let entry: GaugeEntry;
    if (existing !== undefined) {
      if (!sameDefinition(existing, "gauge", definition, undefined) || existing.kind !== "gauge") {
        throw this.instrumentConflict("observableGauge", definition.name);
      }
      entry = existing;
    } else {
      this.assertInstrumentCapacity(definition.name);
      entry = {
        kind: "gauge",
        definition,
        leases: new Set(),
        callbacks: new Map(),
        lifetimeSeries: this.lifetimeSeriesFor(definition.name),
      };
      this.catalog.set(definition.name, entry);
    }
    if (entry.callbacks.size >= maximumCallbacks) {
      throw metricError(
        "LIMIT_EXCEEDED",
        "observableGauge",
        `Observable gauge "${definition.name}" exceeds the ${maximumCallbacks}-callback limit.`,
        definition.name,
        false,
      );
    }
    const callbackId = this.nextGaugeCallbackId();
    entry.leases.add(leaseId);
    entry.callbacks.set(callbackId, { id: callbackId, leaseId, callback });
    return { entry, callbackId };
  }

  unregisterGauge(name: string, callbackId: number): void {
    const entry = this.catalog.get(name);
    if (entry === undefined || entry.kind !== "gauge") {
      return;
    }
    const registration = entry.callbacks.get(callbackId);
    if (registration === undefined) {
      return;
    }
    entry.callbacks.delete(callbackId);
    const leaseStillRegistered = Array.from(entry.callbacks.values()).some(
      (candidate) => candidate.leaseId === registration.leaseId,
    );
    if (!leaseStillRegistered) {
      entry.leases.delete(registration.leaseId);
    }
    if (entry.callbacks.size === 0) {
      this.catalog.delete(name);
    }
  }

  addCounter(
    leaseId: number,
    entry: CounterEntry,
    value: number,
    attributes: NormalizedAttributes,
  ): void {
    this.assertLease(leaseId, "add", entry.definition.name);
    if (!Number.isFinite(value) || value < 0) {
      throw metricError(
        "INVALID_MEASUREMENT",
        "add",
        `Counter "${entry.definition.name}" accepts only finite values greater than or equal to zero.`,
        entry.definition.name,
        false,
      );
    }
    this.prepareSeries(entry, attributes, "add");
    let leaseSeries = entry.seriesByLease.get(leaseId);
    if (leaseSeries === undefined) {
      leaseSeries = new Map();
      entry.seriesByLease.set(leaseId, leaseSeries);
    }
    const current = leaseSeries.get(attributes.identity);
    if (current === undefined) {
      leaseSeries.set(attributes.identity, { attributes, value });
      this.commitSeries(entry, attributes);
    } else {
      current.value += value;
    }
  }

  recordHistogram(
    leaseId: number,
    entry: HistogramEntry,
    value: number,
    attributes: NormalizedAttributes,
  ): void {
    this.assertLease(leaseId, "record", entry.definition.name);
    if (!Number.isFinite(value)) {
      throw metricError(
        "INVALID_MEASUREMENT",
        "record",
        `Histogram "${entry.definition.name}" accepts only finite values.`,
        entry.definition.name,
        false,
      );
    }
    this.prepareSeries(entry, attributes, "record");
    let leaseSeries = entry.seriesByLease.get(leaseId);
    if (leaseSeries === undefined) {
      leaseSeries = new Map();
      entry.seriesByLease.set(leaseId, leaseSeries);
    }
    const current = leaseSeries.get(attributes.identity);
    if (current === undefined) {
      const bucketCounts = Array.from({ length: entry.definition.boundaries.length + 1 }, () => 0);
      const bucketIndex = histogramBucketIndex(entry.definition.boundaries, value);
      bucketCounts[bucketIndex] = 1;
      leaseSeries.set(attributes.identity, {
        attributes,
        count: 1,
        sum: value,
        min: value,
        max: value,
        bucketCounts,
      });
      this.commitSeries(entry, attributes);
    } else {
      current.count++;
      current.sum += value;
      current.min = Math.min(current.min, value);
      current.max = Math.max(current.max, value);
      const bucketIndex = histogramBucketIndex(entry.definition.boundaries, value);
      const count = current.bucketCounts[bucketIndex];
      current.bucketCounts[bucketIndex] = (count ?? 0) + 1;
    }
  }

  private lifetimeSeriesFor(name: string): Set<string> {
    let series = this.lifetimeSeriesByInstrument.get(name);
    if (series === undefined) {
      series = new Set();
      this.lifetimeSeriesByInstrument.set(name, series);
    }
    return series;
  }

  private recordPeriodicOutcome(failed: boolean): void {
    if (failed === this.periodicFailureActive) {
      return;
    }
    this.periodicFailureActive = failed;
    console.warn(
      failed
        ? "OBS_METRICS_PERIODIC_EXPORT_FAILED: The periodic metrics export entered a failed state."
        : "OBS_METRICS_PERIODIC_EXPORT_RECOVERED: The periodic metrics export recovered.",
    );
  }

  private assertInstrumentCapacity(name: string): void {
    if (this.lifetimeInstrumentNames.has(name)) {
      return;
    }
    if (this.lifetimeInstrumentNames.size >= maximumInstruments) {
      throw metricError(
        "LIMIT_EXCEEDED",
        "registerInstrument",
        `Metric runtime exceeds the ${maximumInstruments}-instrument lifetime limit while registering "${name}".`,
        name,
        false,
      );
    }
    this.lifetimeInstrumentNames.add(name);
  }

  private instrumentConflict(operation: string, name: string): MetricsError {
    return metricError(
      "INSTRUMENT_CONFLICT",
      operation,
      `Metric instrument "${name}" conflicts with an existing definition. Reuse the exact kind, unit, description, and boundaries.`,
      name,
      false,
    );
  }

  private assertLease(leaseId: number, operation: string, name: string): void {
    if (!this.leases.has(leaseId)) {
      throw metricError(
        "CLOSED",
        operation,
        `Metrics lifecycle is closed. Create a new lifecycle before using "${name}".`,
        name,
        false,
      );
    }
  }

  private prepareSeries(
    entry: CounterEntry | HistogramEntry,
    attributes: NormalizedAttributes,
    operation: string,
  ): string {
    const runtimeIdentity = `${entry.definition.name}:${attributes.identity}`;
    for (const attribute of attributes.values) {
      const key = `${entry.definition.name}:${attribute.key}`;
      const values = this.lifetimeValuesByInstrumentKey.get(key);
      const identity = attributeIdentity(attribute.value);
      if (
        values !== undefined &&
        !values.has(identity) &&
        values.size >= maximumAttributeCardinality
      ) {
        throw metricError(
          "LIMIT_EXCEEDED",
          operation,
          `Metric "${entry.definition.name}" exceeds the ${maximumAttributeCardinality}-value lifetime limit for one label.`,
          entry.definition.name,
          false,
          undefined,
          attribute.key,
        );
      }
    }
    if (
      !entry.lifetimeSeries.has(attributes.identity) &&
      entry.lifetimeSeries.size >= maximumInstrumentSeries
    ) {
      throw metricError(
        "LIMIT_EXCEEDED",
        operation,
        `Metric "${entry.definition.name}" exceeds the ${maximumInstrumentSeries}-series lifetime limit.`,
        entry.definition.name,
        false,
      );
    }
    if (
      !this.runtimeLifetimeSeries.has(runtimeIdentity) &&
      this.runtimeLifetimeSeries.size >= maximumRuntimeSeries
    ) {
      throw metricError(
        "LIMIT_EXCEEDED",
        operation,
        `Metric runtime exceeds the ${maximumRuntimeSeries}-series lifetime limit.`,
        entry.definition.name,
        false,
      );
    }
    return runtimeIdentity;
  }

  private commitSeries(entry: CatalogEntry, attributes: NormalizedAttributes): void {
    entry.lifetimeSeries.add(attributes.identity);
    this.runtimeLifetimeSeries.add(`${entry.definition.name}:${attributes.identity}`);
    for (const attribute of attributes.values) {
      const key = `${entry.definition.name}:${attribute.key}`;
      let values = this.lifetimeValuesByInstrumentKey.get(key);
      if (values === undefined) {
        values = new Set();
        this.lifetimeValuesByInstrumentKey.set(key, values);
      }
      values.add(attributeIdentity(attribute.value));
    }
  }

  private transportForExport(): MetricsTransport {
    let selected: MetricsTransportBinding | undefined;
    for (const transport of this.transports.values()) {
      if (selected === undefined || transport.kind === "layer") {
        selected = transport;
      }
    }
    if (selected === undefined) {
      throw metricError(
        "EXPORT_FAILED",
        "flush",
        "Metrics export has no active transport. Acquire a runtime lease before flushing.",
        undefined,
        false,
      );
    }
    return selected.send;
  }

  private scheduleExport(timeoutMilliseconds: number): Promise<FlushResult> {
    const controller = new AbortController();
    let timedOut = false;
    const operation = this.tail.then(async () => {
      if (controller.signal.aborted) {
        throw metricError(
          "FLUSH_TIMED_OUT",
          "flush",
          `Metrics flush exceeded ${timeoutMilliseconds} milliseconds. Retry the flush before closing.`,
          undefined,
          true,
        );
      }
      const collection = this.collectPayload();
      const transport = this.transportForExport();
      try {
        await transport(collection.payload, controller.signal);
      } catch (cause) {
        if (timedOut || controller.signal.aborted) {
          throw metricError(
            "FLUSH_TIMED_OUT",
            "flush",
            `Metrics flush exceeded ${timeoutMilliseconds} milliseconds. Retry the flush before closing.`,
            undefined,
            true,
            cause,
          );
        }
        throw metricError(
          "EXPORT_FAILED",
          "flush",
          "Metrics export failed. Verify the OTLP endpoint and retry the flush.",
          undefined,
          true,
          cause,
        );
      }
      return collection.result;
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<FlushResult>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          metricError(
            "FLUSH_TIMED_OUT",
            "flush",
            `Metrics flush exceeded ${timeoutMilliseconds} milliseconds. Retry the flush before closing.`,
            undefined,
            true,
          ),
        );
      }, timeoutMilliseconds);
    });
    return Promise.race([operation, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }

  private collectPayload(): { readonly payload: MetricsPayload; readonly result: FlushResult } {
    const timeUnixNano = nanosNow();
    const metrics: Array<OtlpMetric> = [];
    const names = new Map<string, { readonly kind: string; readonly definition: string }>();
    const gaugeFailures: Array<GaugeCollectionFailure> = [];
    for (const snapshot of Metric.snapshotUnsafe(this.directContext)) {
      this.appendDirectMetric(metrics, names, snapshot, timeUnixNano, gaugeFailures);
    }
    for (const entry of this.catalog.values()) {
      const existing = names.get(entry.definition.name);
      const definitionIdentity = `${entry.kind}:${entry.definition.unit}:${entry.definition.description}`;
      if (existing !== undefined && existing.definition !== definitionIdentity) {
        throw metricError(
          "EXPORT_FAILED",
          "flush",
          `Metric "${entry.definition.name}" conflicts with a direct Effect metric. Rename one instrument before retrying.`,
          entry.definition.name,
          false,
        );
      }
      names.set(entry.definition.name, { kind: entry.kind, definition: definitionIdentity });
      if (entry.kind === "counter") {
        metrics.push(this.collectCounter(entry, timeUnixNano));
      } else if (entry.kind === "histogram") {
        metrics.push(this.collectHistogram(entry, timeUnixNano));
      } else {
        const gauge = this.collectGauge(entry, timeUnixNano);
        gaugeFailures.push(...gauge.failures);
        if (gauge.metric !== undefined) {
          metrics.push(gauge.metric);
        }
      }
    }
    return {
      payload: {
        resourceMetrics: [
          {
            resource: {
              attributes: Array.from(this.options.resourceAttributes, ([key, value]) => ({
                key,
                value: { stringValue: value },
              })),
              droppedAttributesCount: 0,
            },
            scopeMetrics: [
              {
                scope: { name: this.options.identity.serviceName },
                metrics,
              },
            ],
          },
        ],
      },
      result: { gaugeFailures },
    };
  }

  private appendDirectMetric(
    metrics: Array<OtlpMetric>,
    names: Map<string, { readonly kind: string; readonly definition: string }>,
    snapshot: Metric.Metric.Snapshot,
    timeUnixNano: string,
    failures: Array<GaugeCollectionFailure>,
  ): void {
    const unit = snapshot.attributes?.unit ?? snapshot.attributes?.time_unit ?? "1";
    const description = snapshot.description ?? "";
    const definitionIdentity = `${snapshot.type}:${unit}:${description}`;
    const existing = names.get(snapshot.id);
    if (existing !== undefined && existing.definition !== definitionIdentity) {
      throw metricError(
        "EXPORT_FAILED",
        "flush",
        `Direct Effect metric "${snapshot.id}" has incompatible definitions. Rename or align the definitions before retrying.`,
        snapshot.id,
        false,
      );
    }
    const policyAttributes = directAttributesToOtlp(
      snapshot.attributes,
      snapshot.id,
      this.options.policy,
    );
    const attributes = policyAttributes.values;
    failures.push(...policyAttributes.failures);
    const previous = metrics.find((metric) => metric.name === snapshot.id);
    names.set(snapshot.id, { kind: snapshot.type, definition: definitionIdentity });
    if (snapshot.type === "Counter") {
      const point = this.numberPoint(snapshot.state.count, attributes, timeUnixNano);
      if (previous?.sum !== undefined) {
        previous.sum.dataPoints.push(point);
      } else {
        metrics.push({
          name: snapshot.id,
          description,
          unit,
          sum: {
            aggregationTemporality: 2,
            isMonotonic: snapshot.state.incremental,
            dataPoints: [point],
          },
        });
      }
    } else if (snapshot.type === "Gauge") {
      const point = this.numberPoint(snapshot.state.value, attributes, timeUnixNano);
      if (previous?.gauge !== undefined) {
        previous.gauge.dataPoints.push(point);
      } else {
        metrics.push({ name: snapshot.id, description, unit, gauge: { dataPoints: [point] } });
      }
    } else if (snapshot.type === "Histogram") {
      const buckets: Array<number> = [];
      const bounds: Array<number> = [];
      let previousCount = 0;
      for (let index = 0; index < snapshot.state.buckets.length; index++) {
        const bucket = snapshot.state.buckets[index];
        if (bucket !== undefined) {
          if (index < snapshot.state.buckets.length - 1) {
            bounds.push(bucket[0]);
          }
          buckets.push(bucket[1] - previousCount);
          previousCount = bucket[1];
        }
      }
      const point: OtlpHistogramDataPoint = {
        attributes,
        startTimeUnixNano: this.startTimeUnixNano,
        timeUnixNano,
        count: snapshot.state.count,
        sum: snapshot.state.sum,
        min: snapshot.state.min,
        max: snapshot.state.max,
        explicitBounds: bounds,
        bucketCounts: buckets,
      };
      if (previous?.histogram !== undefined) {
        previous.histogram.dataPoints.push(point);
      } else {
        metrics.push({
          name: snapshot.id,
          description,
          unit,
          histogram: { aggregationTemporality: 2, dataPoints: [point] },
        });
      }
    } else if (snapshot.type === "Frequency") {
      const dataPoints: Array<OtlpNumberDataPoint> = [];
      for (const [key, value] of snapshot.state.occurrences) {
        dataPoints.push({
          ...this.numberPoint(value, attributes, timeUnixNano),
          attributes: [...attributes, { key: "key", value: { stringValue: key } }],
        });
      }
      if (previous?.sum !== undefined) {
        previous.sum.dataPoints.push(...dataPoints);
      } else {
        metrics.push({
          name: snapshot.id,
          description,
          unit,
          sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints },
        });
      }
    } else {
      const derivedNames = [
        `${snapshot.id}_quantiles`,
        `${snapshot.id}_count`,
        `${snapshot.id}_sum`,
      ];
      for (const derivedName of derivedNames) {
        const derivedDefinition = `${definitionIdentity}:${derivedName}`;
        const derivedExisting = names.get(derivedName);
        if (derivedExisting !== undefined && derivedExisting.definition !== derivedDefinition) {
          throw metricError(
            "EXPORT_FAILED",
            "flush",
            `Direct Effect summary "${snapshot.id}" conflicts with metric "${derivedName}". Rename one instrument before retrying.`,
            snapshot.id,
            false,
          );
        }
        names.set(derivedName, { kind: "Summary", definition: derivedDefinition });
      }
      const dataPoints: Array<OtlpNumberDataPoint> = [];
      dataPoints.push({
        ...this.numberPoint(snapshot.state.min, attributes, timeUnixNano),
        attributes: [...attributes, { key: "quantile", value: { stringValue: "min" } }],
      });
      for (const [quantile, value] of snapshot.state.quantiles) {
        dataPoints.push({
          ...this.numberPoint(value ?? 0, attributes, timeUnixNano),
          attributes: [
            ...attributes,
            { key: "quantile", value: { stringValue: quantile.toString() } },
          ],
        });
      }
      dataPoints.push({
        ...this.numberPoint(snapshot.state.max, attributes, timeUnixNano),
        attributes: [...attributes, { key: "quantile", value: { stringValue: "max" } }],
      });
      const countPoint = this.numberPoint(snapshot.state.count, attributes, timeUnixNano);
      const sumPoint = this.numberPoint(snapshot.state.sum, attributes, timeUnixNano);
      const existingQuantiles = metrics.find(
        (metric) => metric.name === `${snapshot.id}_quantiles`,
      );
      const existingCount = metrics.find((metric) => metric.name === `${snapshot.id}_count`);
      const existingSum = metrics.find((metric) => metric.name === `${snapshot.id}_sum`);
      if (
        existingQuantiles?.sum !== undefined &&
        existingCount?.sum !== undefined &&
        existingSum?.sum !== undefined
      ) {
        existingQuantiles.sum.dataPoints.push(...dataPoints);
        existingCount.sum.dataPoints.push(countPoint);
        existingSum.sum.dataPoints.push(sumPoint);
      } else {
        metrics.push(
          {
            name: `${snapshot.id}_quantiles`,
            description,
            unit,
            sum: { aggregationTemporality: 2, isMonotonic: false, dataPoints },
          },
          {
            name: `${snapshot.id}_count`,
            description,
            unit: "1",
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [countPoint],
            },
          },
          {
            name: `${snapshot.id}_sum`,
            description,
            unit: "1",
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [sumPoint],
            },
          },
        );
      }
    }
  }

  private numberPoint(
    value: number | bigint,
    attributes: ReadonlyArray<OtlpKeyValue>,
    timeUnixNano: string,
  ): OtlpNumberDataPoint {
    const common = {
      attributes,
      startTimeUnixNano: this.startTimeUnixNano,
      timeUnixNano,
    };
    if (Predicate.isBigInt(value)) {
      return { ...common, asInt: Number(value) };
    }
    return { ...common, asDouble: value };
  }

  private collectCounter(entry: CounterEntry, timeUnixNano: string): OtlpMetric {
    const combined = new Map<string, CounterSeries>();
    for (const [identity, series] of entry.residualSeries) {
      combined.set(identity, { attributes: series.attributes, value: series.value });
    }
    for (const leaseSeries of entry.seriesByLease.values()) {
      for (const [identity, series] of leaseSeries) {
        const current = combined.get(identity);
        if (current === undefined) {
          combined.set(identity, { attributes: series.attributes, value: series.value });
        } else {
          current.value += series.value;
        }
      }
    }
    return {
      name: entry.definition.name,
      description: entry.definition.description,
      unit: entry.definition.unit,
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: Array.from(combined.values()).map((series) => ({
          attributes: attributesToOtlp(series.attributes.values),
          startTimeUnixNano: this.startTimeUnixNano,
          timeUnixNano,
          asDouble: series.value,
        })),
      },
    };
  }

  private collectHistogram(entry: HistogramEntry, timeUnixNano: string): OtlpMetric {
    const combined = new Map<string, HistogramSeries>();
    for (const [identity, series] of entry.residualSeries) {
      combined.set(identity, {
        attributes: series.attributes,
        count: series.count,
        sum: series.sum,
        min: series.min,
        max: series.max,
        bucketCounts: [...series.bucketCounts],
      });
    }
    for (const leaseSeries of entry.seriesByLease.values()) {
      for (const [identity, series] of leaseSeries) {
        const current = combined.get(identity);
        if (current === undefined) {
          combined.set(identity, {
            attributes: series.attributes,
            count: series.count,
            sum: series.sum,
            min: series.min,
            max: series.max,
            bucketCounts: [...series.bucketCounts],
          });
        } else {
          current.count += series.count;
          current.sum += series.sum;
          current.min = Math.min(current.min, series.min);
          current.max = Math.max(current.max, series.max);
          for (let index = 0; index < current.bucketCounts.length; index++) {
            current.bucketCounts[index] =
              (current.bucketCounts[index] ?? 0) + (series.bucketCounts[index] ?? 0);
          }
        }
      }
    }
    return {
      name: entry.definition.name,
      description: entry.definition.description,
      unit: entry.definition.unit,
      histogram: {
        aggregationTemporality: 2,
        dataPoints: Array.from(combined.values()).map((series) => ({
          attributes: attributesToOtlp(series.attributes.values),
          startTimeUnixNano: this.startTimeUnixNano,
          timeUnixNano,
          count: series.count,
          sum: series.sum,
          min: series.min,
          max: series.max,
          explicitBounds: entry.definition.boundaries,
          bucketCounts: series.bucketCounts,
        })),
      },
    };
  }

  private collectGauge(
    entry: GaugeEntry,
    timeUnixNano: string,
  ): {
    readonly metric: OtlpMetric | undefined;
    readonly failures: ReadonlyArray<GaugeCollectionFailure>;
  } {
    const observations: Array<{
      readonly value: number;
      readonly attributes: NormalizedAttributes;
    }> = [];
    const failures: Array<GaugeCollectionFailure> = [];
    const proposedIdentities = new Set<string>();
    for (const registration of entry.callbacks.values()) {
      let callbackResult: ReadonlyArray<GaugeObservation>;
      try {
        callbackResult = registration.callback();
      } catch {
        failures.push({
          instrumentName: entry.definition.name,
          code: "CALLBACK_FAILED",
          message: `Observable gauge "${entry.definition.name}" callback failed and was omitted from this export.`,
        });
        continue;
      }
      let callbackObservations: ReadonlyArray<GaugeObservation>;
      try {
        callbackObservations = decodeGaugeObservations(callbackResult);
      } catch {
        failures.push({
          instrumentName: entry.definition.name,
          code: "INVALID_OBSERVATION",
          message: `Observable gauge "${entry.definition.name}" returned an invalid synchronous observation batch.`,
        });
        continue;
      }
      if (callbackObservations.length > maximumObservations) {
        failures.push({
          instrumentName: entry.definition.name,
          code: "SERIES_LIMIT_EXCEEDED",
          message: `Observable gauge "${entry.definition.name}" exceeds the ${maximumObservations}-observation collection limit.`,
        });
        continue;
      }
      const callbackBatch: Array<{
        readonly value: number;
        readonly attributes: NormalizedAttributes;
      }> = [];
      const callbackIdentities = new Set<string>();
      let callbackFailed = false;
      for (const observation of callbackObservations) {
        if (!Number.isFinite(observation.value)) {
          failures.push({
            instrumentName: entry.definition.name,
            code: "INVALID_OBSERVATION",
            message: `Observable gauge "${entry.definition.name}" produced a non-finite observation.`,
          });
          callbackFailed = true;
          break;
        }
        try {
          const attributes = parseAttributes(
            observation.attributes,
            "collectObservableGauge",
            entry.definition.name,
            this.policy,
          );
          if (
            proposedIdentities.has(attributes.identity) ||
            callbackIdentities.has(attributes.identity)
          ) {
            failures.push({
              instrumentName: entry.definition.name,
              code: "INVALID_OBSERVATION",
              message: `Observable gauge "${entry.definition.name}" produced duplicate attribute sets.`,
            });
            callbackFailed = true;
            break;
          }
          callbackIdentities.add(attributes.identity);
          callbackBatch.push({ value: observation.value, attributes });
        } catch (cause) {
          const code =
            cause instanceof MetricsError && cause.code === "LIMIT_EXCEEDED"
              ? "ATTRIBUTE_LIMIT_EXCEEDED"
              : "INVALID_OBSERVATION";
          failures.push({
            instrumentName: entry.definition.name,
            code,
            message: `Observable gauge "${entry.definition.name}" produced invalid bounded attributes.`,
          });
          callbackFailed = true;
          break;
        }
      }
      if (!callbackFailed) {
        for (const observation of callbackBatch) {
          proposedIdentities.add(observation.attributes.identity);
          observations.push(observation);
        }
      }
    }
    if (failures.length > 0) {
      return { metric: undefined, failures };
    }
    const newIdentities = Array.from(proposedIdentities).filter(
      (identity) => !entry.lifetimeSeries.has(identity),
    );
    const newRuntimeIdentities = newIdentities.filter(
      (identity) => !this.runtimeLifetimeSeries.has(`${entry.definition.name}:${identity}`),
    );
    if (
      entry.lifetimeSeries.size + newIdentities.length > maximumInstrumentSeries ||
      this.runtimeLifetimeSeries.size + newRuntimeIdentities.length > maximumRuntimeSeries
    ) {
      return {
        metric: undefined,
        failures: [
          {
            instrumentName: entry.definition.name,
            code: "SERIES_LIMIT_EXCEEDED",
            message: `Observable gauge "${entry.definition.name}" exceeds a lifetime series limit.`,
          },
        ],
      };
    }
    for (const identity of newIdentities) {
      const observation = observations.find(
        (candidate) => candidate.attributes.identity === identity,
      );
      if (observation !== undefined) {
        this.commitSeries(entry, observation.attributes);
      }
    }
    return {
      metric: {
        name: entry.definition.name,
        description: entry.definition.description,
        unit: entry.definition.unit,
        gauge: {
          dataPoints: observations.map((observation) => ({
            attributes: attributesToOtlp(observation.attributes.values),
            startTimeUnixNano: this.startTimeUnixNano,
            timeUnixNano,
            asDouble: observation.value,
          })),
        },
      },
      failures: [],
    };
  }

  private foldCounterLease(entry: CounterEntry, leaseId: number): void {
    const leaseSeries = entry.seriesByLease.get(leaseId);
    if (leaseSeries === undefined) {
      return;
    }
    for (const [identity, series] of leaseSeries) {
      const residual = entry.residualSeries.get(identity);
      if (residual === undefined) {
        entry.residualSeries.set(identity, {
          attributes: series.attributes,
          value: series.value,
        });
      } else {
        residual.value += series.value;
      }
    }
    entry.seriesByLease.delete(leaseId);
  }

  private foldHistogramLease(entry: HistogramEntry, leaseId: number): void {
    const leaseSeries = entry.seriesByLease.get(leaseId);
    if (leaseSeries === undefined) {
      return;
    }
    for (const [identity, series] of leaseSeries) {
      const residual = entry.residualSeries.get(identity);
      if (residual === undefined) {
        entry.residualSeries.set(identity, {
          attributes: series.attributes,
          count: series.count,
          sum: series.sum,
          min: series.min,
          max: series.max,
          bucketCounts: [...series.bucketCounts],
        });
      } else {
        residual.count += series.count;
        residual.sum += series.sum;
        residual.min = Math.min(residual.min, series.min);
        residual.max = Math.max(residual.max, series.max);
        for (let index = 0; index < residual.bucketCounts.length; index++) {
          residual.bucketCounts[index] =
            (residual.bucketCounts[index] ?? 0) + (series.bucketCounts[index] ?? 0);
        }
      }
    }
    entry.seriesByLease.delete(leaseId);
  }

  private removeLeaseState(leaseId: number): void {
    for (const [name, entry] of this.catalog) {
      entry.leases.delete(leaseId);
      if (entry.kind === "counter") {
        this.foldCounterLease(entry, leaseId);
        if (entry.leases.size === 0 && entry.residualSeries.size === 0) {
          this.catalog.delete(name);
        }
      } else if (entry.kind === "histogram") {
        this.foldHistogramLease(entry, leaseId);
        if (entry.leases.size === 0 && entry.residualSeries.size === 0) {
          this.catalog.delete(name);
        }
      } else {
        for (const [callbackId, registration] of entry.callbacks) {
          if (registration.leaseId === leaseId) {
            entry.callbacks.delete(callbackId);
          }
        }
        if (entry.leases.size === 0) {
          this.catalog.delete(name);
        }
      }
    }
  }
}

const runtimePool = new Map<string, MetricsRuntimeState>();

const fetchTransport =
  (endpoint: string): MetricsTransport =>
  async (payload, signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      throw metricError(
        "EXPORT_FAILED",
        "export",
        `OTLP metrics endpoint returned HTTP ${response.status}. Verify the endpoint and retry.`,
        undefined,
        true,
      );
    }
  };

const acquireRuntime = (
  options: NormalizedOptions,
  transport: MetricsTransportBinding,
): RuntimeLease => {
  let state = runtimePool.get(options.poolKey);
  if (state === undefined) {
    state = new MetricsRuntimeState(options, () => {
      if (runtimePool.get(options.poolKey) === state) {
        runtimePool.delete(options.poolKey);
      }
    });
    runtimePool.set(options.poolKey, state);
  }
  return state.acquire(transport);
};

class ActiveMetrics implements Metrics {
  private readonly lease: RuntimeLease;
  private readonly timeoutMilliseconds: number;
  private closed = false;
  private closePromise: Promise<FlushResult> | undefined;

  constructor(lease: RuntimeLease, timeoutMilliseconds: number) {
    this.lease = lease;
    this.timeoutMilliseconds = timeoutMilliseconds;
  }

  counter(definitionInput: CounterDefinition): Counter {
    this.assertOpen("counter");
    const definition = parseDefinition(definitionInput, "counter");
    const entry = this.lease.state.registerCounter(this.lease.leaseId, definition);
    return {
      add: (value, attributes) => {
        this.assertOpen("add", definition.name);
        const parsedAttributes = parseAttributes(
          attributes,
          "add",
          definition.name,
          this.lease.state.policy,
        );
        this.lease.state.addCounter(this.lease.leaseId, entry, value, parsedAttributes);
      },
    };
  }

  histogram(definitionInput: HistogramDefinition): Histogram {
    this.assertOpen("histogram");
    const definition = parseHistogramDefinition(definitionInput);
    const entry = this.lease.state.registerHistogram(this.lease.leaseId, definition);
    return {
      record: (value, attributes) => {
        this.assertOpen("record", definition.name);
        const parsedAttributes = parseAttributes(
          attributes,
          "record",
          definition.name,
          this.lease.state.policy,
        );
        this.lease.state.recordHistogram(this.lease.leaseId, entry, value, parsedAttributes);
      },
    };
  }

  observableGauge(
    definitionInput: InstrumentDefinition,
    callback: ObservableGaugeCallback,
  ): ObservableGaugeRegistration {
    this.assertOpen("observableGauge");
    const definition = parseDefinition(definitionInput, "observableGauge");
    if (!Predicate.isFunction(callback)) {
      throw metricError(
        "INVALID_INSTRUMENT",
        "observableGauge",
        `Observable gauge "${definition.name}" requires a synchronous callback.`,
        definition.name,
        false,
      );
    }
    const registered = this.lease.state.registerGauge(this.lease.leaseId, definition, callback);
    let unregistered = false;
    const unregister = (): void => {
      if (unregistered) {
        return;
      }
      unregistered = true;
      this.lease.state.unregisterGauge(definition.name, registered.callbackId);
    };
    return { unregister, [Symbol.dispose]: unregister };
  }

  flush(): Promise<FlushResult> {
    this.assertOpen("flush");
    return this.lease.state.flush(this.timeoutMilliseconds);
  }

  close(): Promise<FlushResult> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.lease.state.closeLease(this.lease.leaseId, this.timeoutMilliseconds);
    return this.closePromise;
  }

  private assertOpen(operation: string, instrumentName?: string): void {
    if (this.closed) {
      throw metricError(
        "CLOSED",
        operation,
        "Metrics lifecycle is closed. Create a new lifecycle before recording or flushing metrics.",
        instrumentName,
        false,
      );
    }
  }
}

class DisabledMetrics implements Metrics {
  private closed = false;
  private closePromise: Promise<FlushResult> | undefined;

  constructor(private readonly policy: DataPolicy) {}

  counter(definitionInput: CounterDefinition): Counter {
    this.assertOpen("counter");
    const definition = parseDefinition(definitionInput, "counter");
    return {
      add: (value, attributes) => {
        this.assertOpen("add", definition.name);
        if (!Number.isFinite(value) || value < 0) {
          throw metricError(
            "INVALID_MEASUREMENT",
            "add",
            `Counter "${definition.name}" accepts only finite values greater than or equal to zero.`,
            definition.name,
            false,
          );
        }
        parseAttributes(attributes, "add", definition.name, this.policy);
      },
    };
  }

  histogram(definitionInput: HistogramDefinition): Histogram {
    this.assertOpen("histogram");
    const definition = parseHistogramDefinition(definitionInput);
    return {
      record: (value, attributes) => {
        this.assertOpen("record", definition.name);
        if (!Number.isFinite(value)) {
          throw metricError(
            "INVALID_MEASUREMENT",
            "record",
            `Histogram "${definition.name}" accepts only finite values.`,
            definition.name,
            false,
          );
        }
        parseAttributes(attributes, "record", definition.name, this.policy);
      },
    };
  }

  observableGauge(
    definitionInput: InstrumentDefinition,
    callback: ObservableGaugeCallback,
  ): ObservableGaugeRegistration {
    this.assertOpen("observableGauge");
    const definition = parseDefinition(definitionInput, "observableGauge");
    if (!Predicate.isFunction(callback)) {
      throw metricError(
        "INVALID_INSTRUMENT",
        "observableGauge",
        `Observable gauge "${definition.name}" requires a synchronous callback.`,
        definition.name,
        false,
      );
    }
    const unregister = (): void => undefined;
    return { unregister, [Symbol.dispose]: unregister };
  }

  flush(): Promise<FlushResult> {
    this.assertOpen("flush");
    return Promise.resolve({ gaugeFailures: [] });
  }

  close(): Promise<FlushResult> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = Promise.resolve({ gaugeFailures: [] });
    return this.closePromise;
  }

  private assertOpen(operation: string, instrumentName?: string): void {
    if (this.closed) {
      throw metricError(
        "CLOSED",
        operation,
        "Metrics lifecycle is closed. Create a new lifecycle before recording or flushing metrics.",
        instrumentName,
        false,
      );
    }
  }
}

export const createStandaloneMetrics = async (optionsInput: MetricsOptions): Promise<Metrics> => {
  const options = parseOptions(optionsInput);
  if (!options.enabled) {
    return new DisabledMetrics(options.policy);
  }
  const lease = acquireRuntime(options, {
    kind: "fetch",
    send: fetchTransport(options.metricsEndpoint),
  });
  return new ActiveMetrics(lease, options.flushTimeoutMilliseconds);
};

interface LayerMetricsOptions {
  readonly shutdownTimeoutMilliseconds: number;
  readonly policy: DataPolicy;
  readonly resourceAttributes: ReadonlyMap<string, string>;
}

const makeEffectTransport = (endpoint: string, client: HttpClient.HttpClient): MetricsTransport => {
  const request = HttpClientRequest.post(endpoint, {
    headers: { "content-type": "application/json" },
  });
  return async (payload, signal) => {
    const program = client
      .execute(HttpClientRequest.setBody(request, HttpBody.jsonUnsafe(payload)))
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(
                metricError(
                  "EXPORT_FAILED",
                  "export",
                  `OTLP metrics endpoint returned HTTP ${response.status}. Verify the endpoint and retry.`,
                  undefined,
                  true,
                ),
              ),
        ),
        Effect.scoped,
      );
    await Effect.runPromise(program, { signal });
  };
};

const makeMetricsRuntime = Effect.fn("makeMetricsRuntime")(function* (
  config: TelemetryConfig,
  options: LayerMetricsOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const flusher = yield* OtlpExporter.Flusher;
  const parsed = parseOptions({
    serviceName: config.identity.serviceName,
    serviceVersion: config.identity.serviceVersion,
    environment: config.identity.environment,
    deploymentEnvironmentAlias: config.environmentAlias,
    otlpEndpoint: config.otlpEndpoint.toString(),
    flushTimeoutMilliseconds: options.shutdownTimeoutMilliseconds,
    policy: options.policy,
  });
  const resourceAttributes = new Map(options.resourceAttributes);
  resourceAttributes.delete("service.instance.id");
  const parsedResourceKey = JSON.stringify(Array.from(parsed.resourceAttributes));
  const resourceKey = JSON.stringify(Array.from(resourceAttributes));
  const normalized = {
    ...parsed,
    poolKey:
      resourceKey === parsedResourceKey
        ? parsed.poolKey
        : JSON.stringify([parsed.poolKey, resourceKey]),
    resourceAttributes,
  } satisfies NormalizedOptions;
  const lease = acquireRuntime(normalized, {
    kind: "layer",
    send: makeEffectTransport(normalized.metricsEndpoint, client),
  });
  yield* flusher.register(
    Effect.tryPromise(() => lease.state.flush(parsed.flushTimeoutMilliseconds)).pipe(
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() =>
      lease.state.closeLease(lease.leaseId, parsed.flushTimeoutMilliseconds),
    ).pipe(
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    ),
  );
  return lease.state.registry;
});

export const layerMetricsRuntime = (config: TelemetryConfig, options: LayerMetricsOptions) =>
  Layer.effect(Metric.MetricRegistry, makeMetricsRuntime(config, options)).pipe(
    Layer.provideMerge(OtlpExporter.layerFlusher),
  );
