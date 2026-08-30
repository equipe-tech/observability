import { Schema } from "effect";
import { isReservedEventNamePart, isValidAttributeName } from "./EventName.ts";
import { isForbiddenMetricAttributeName } from "../policy/MetricLabelPolicy.ts";
import {
  containsControlCharacter,
  instrumentNamePattern,
  maximumMetricAttributeCardinality,
  maximumMetricAttributes,
  unitPattern,
} from "../metrics/InstrumentGrammar.ts";

export type MetricKind = "counter" | "histogram" | "observable_gauge";
export type MetricAttributeScalar = string | number | boolean;

export type MetricAttributeDefinitionInput = {
  readonly classification: "public" | "internal";
  readonly maximumCardinality: number;
  readonly allowedValues?: readonly [
    MetricAttributeScalar,
    ...ReadonlyArray<MetricAttributeScalar>,
  ];
};

export type MetricAttributeDefinitionsInput = {
  readonly [attributeName: string]: MetricAttributeDefinitionInput;
};

type MetricDefinitionBase = {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly attributes: MetricAttributeDefinitionsInput;
};

export type CounterMetricDefinitionInput = MetricDefinitionBase & {
  readonly kind: "counter";
  readonly boundaries?: never;
};

export type HistogramMetricDefinitionInput = MetricDefinitionBase & {
  readonly kind: "histogram";
  readonly boundaries: ReadonlyArray<number>;
};

export type ObservableGaugeMetricDefinitionInput = MetricDefinitionBase & {
  readonly kind: "observable_gauge";
  readonly boundaries?: never;
};

export type MetricDefinitionInput =
  | CounterMetricDefinitionInput
  | HistogramMetricDefinitionInput
  | ObservableGaugeMetricDefinitionInput;

export type MetricDefinitionsInput = {
  readonly [alias: string]: MetricDefinitionInput;
};

type CompiledMetricDefinitionBase = {
  readonly alias: string;
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly attributes: ReadonlyMap<string, MetricAttributeDefinitionInput>;
};

export type CompiledMetricDefinition =
  | (CompiledMetricDefinitionBase & {
      readonly kind: "counter";
      readonly boundaries?: never;
    })
  | (CompiledMetricDefinitionBase & {
      readonly kind: "histogram";
      readonly boundaries: ReadonlyArray<number>;
    })
  | (CompiledMetricDefinitionBase & {
      readonly kind: "observable_gauge";
      readonly boundaries?: never;
    });

export const defineMetricDefinitions = <const Metrics extends MetricDefinitionsInput>(
  metrics: Metrics,
): Metrics => metrics;

const metricNamePattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const reservedMetricParts = new Set([
  "production",
  "prod",
  "staging",
  "stage",
  "development",
  "dev",
  "test",
  "local",
  "sandbox",
  "qa",
  "preview",
  "debug",
  "info",
  "warn",
  "warning",
  "fatal",
  "critical",
  "trace",
  "verbose",
  "severity",
  "success",
  "succeeded",
  "failure",
  "failed",
  "cancelled",
  "canceled",
  "ok",
  "outcome",
  "errored",
  "error",
  "service",
  "environment",
  "instance",
  "host",
  "pod",
  "node",
  "region",
  "zone",
  "cluster",
  "namespace",
  "ms",
  "seconds",
  "bytes",
  "count",
  "percent",
  "ratio",
  "unit",
]);

export const isValidMetricName = (name: string): boolean =>
  name.length <= 128 &&
  metricNamePattern.test(name) &&
  instrumentNamePattern.test(name) &&
  name.split(".").every((part) => !isReservedEventNamePart(part) && !reservedMetricParts.has(part));

export const isValidMetricDescription = (description: string): boolean =>
  description.length > 0 && description.length <= 1_024 && !containsControlCharacter(description);

export const isValidMetricUnit = (unit: string): boolean =>
  unit.length <= 63 && unitPattern.test(unit);

export const isValidHistogramBoundaries = (boundaries: ReadonlyArray<number>): boolean => {
  if (boundaries.length === 0 || boundaries.length > 50) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const boundary of boundaries) {
    if (!Number.isFinite(boundary) || boundary <= previous) return false;
    previous = boundary;
  }
  return true;
};

export const isValidMetricAttributeName = (name: string): boolean =>
  isValidAttributeName(name) && !isForbiddenMetricAttributeName(name);
export const isValidMetricAttributeCount = (count: number): boolean =>
  count <= maximumMetricAttributes;
export const isValidMetricCardinality = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= maximumMetricAttributeCardinality;

const scalarSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const isMetricScalar = Schema.is(scalarSchema);

export const validAllowedValues = (
  values: ReadonlyArray<MetricAttributeScalar> | undefined,
  maximumCardinality: number,
): boolean => {
  if (values === undefined) return true;
  if (values.length === 0 || values.length > maximumCardinality) return false;
  const identities = new Set<string>();
  for (const value of values) {
    if (!isMetricScalar(value) || (Schema.is(Schema.Number)(value) && !Number.isFinite(value))) {
      return false;
    }
    const identity = `${Schema.is(Schema.String)(value) ? "string" : Schema.is(Schema.Number)(value) ? "number" : "boolean"}:${String(value)}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
};
