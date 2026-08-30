import type {
  Counter,
  Histogram,
  MetricAttribute,
  MetricAttributeValue,
  Metrics,
  ObservableGaugeRegistration,
} from "../Metrics.ts";
import {
  prepareContractMetricAttributes,
  registerContractGaugeObservation,
} from "../MetricsRuntime.ts";
import type { TelemetryContract, TelemetryContractInput } from "./TelemetryContract.ts";
import type {
  CompiledMetricDefinition,
  MetricAttributeDefinitionInput,
  MetricDefinitionInput,
} from "./MetricDefinition.ts";
import { InvalidMetricMeasurement } from "./MetricContractError.ts";
import { isFiniteMetricScalar, metricScalarIdentity } from "../metrics/MetricScalar.ts";

export type MetricAttributeValueOf<Definition extends MetricAttributeDefinitionInput> =
  Definition["allowedValues"] extends ReadonlyArray<infer Value extends MetricAttributeValue>
    ? Value
    : MetricAttributeValue;

export type MetricAttributesOf<Definition extends MetricDefinitionInput> = {
  readonly [Name in keyof Definition["attributes"]]: MetricAttributeValueOf<
    Definition["attributes"][Name]
  >;
};

type AliasesOfKind<Definition extends TelemetryContractInput, Kind extends string> = {
  readonly [Alias in keyof Definition["metrics"]]: Definition["metrics"][Alias]["kind"] extends Kind
    ? Alias
    : never;
}[keyof Definition["metrics"]] &
  string;

export type ContractCounter<
  Definition extends TelemetryContractInput,
  Alias extends AliasesOfKind<Definition, "counter">,
> = {
  readonly add: (
    value: number,
    attributes: MetricAttributesOf<Definition["metrics"][Alias]>,
  ) => void;
};

export type ContractHistogram<
  Definition extends TelemetryContractInput,
  Alias extends AliasesOfKind<Definition, "histogram">,
> = {
  readonly record: (
    value: number,
    attributes: MetricAttributesOf<Definition["metrics"][Alias]>,
  ) => void;
};

export type ContractGaugeObservation<Definition extends MetricDefinitionInput> = {
  readonly value: number;
  readonly attributes: MetricAttributesOf<Definition>;
};

export type MetricProducer<Definition extends TelemetryContractInput> = {
  readonly counter: <Alias extends AliasesOfKind<Definition, "counter">>(
    alias: Alias,
  ) => ContractCounter<Definition, Alias>;
  readonly histogram: <Alias extends AliasesOfKind<Definition, "histogram">>(
    alias: Alias,
  ) => ContractHistogram<Definition, Alias>;
  readonly observableGauge: <Alias extends AliasesOfKind<Definition, "observable_gauge">>(
    alias: Alias,
    callback: () => ReadonlyArray<ContractGaugeObservation<Definition["metrics"][Alias]>>,
  ) => ObservableGaugeRegistration;
};

const measurementError = (
  code: InvalidMetricMeasurement["code"],
  operation: string,
  alias: string,
  metricName: string | undefined,
  message: string,
  attributeName?: string,
): InvalidMetricMeasurement => {
  const options: {
    code: InvalidMetricMeasurement["code"];
    operation: string;
    message: string;
    metricAlias: string;
    metricName?: string;
    attributeName?: string;
  } = { code, operation, message, metricAlias: alias };
  if (metricName !== undefined) options.metricName = metricName;
  if (attributeName !== undefined) options.attributeName = attributeName;
  return new InvalidMetricMeasurement(options);
};

function resolveDefinition<Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  alias: string,
  kind: "counter",
): Extract<CompiledMetricDefinition, { readonly kind: "counter" }>;
function resolveDefinition<Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  alias: string,
  kind: "histogram",
): Extract<CompiledMetricDefinition, { readonly kind: "histogram" }>;
function resolveDefinition<Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  alias: string,
  kind: "observable_gauge",
): Extract<CompiledMetricDefinition, { readonly kind: "observable_gauge" }>;
function resolveDefinition<Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  alias: string,
  kind: MetricDefinitionInput["kind"],
): CompiledMetricDefinition {
  const definition = contract.metricByAlias.get(alias);
  if (definition === undefined) {
    throw measurementError(
      "OBS_METRIC_UNKNOWN_ALIAS",
      kind,
      alias,
      undefined,
      `Metric alias "${alias}" is not declared by the telemetry contract. Use a declared alias.`,
    );
  }
  if (definition.kind !== kind) {
    throw measurementError(
      "OBS_METRIC_KIND_MISMATCH",
      kind,
      alias,
      definition.name,
      `Metric alias "${alias}" has kind "${definition.kind}", not "${kind}". Use the matching producer method.`,
    );
  }
  return definition;
}

const parseContractAttributes = (
  alias: string,
  definition: CompiledMetricDefinition,
  input: { readonly [name: string]: MetricAttributeValue },
): ReadonlyArray<MetricAttribute> => {
  const attributes: Array<MetricAttribute> = [];
  for (const attributeName of definition.attributes.keys()) {
    if (!Object.hasOwn(input, attributeName)) {
      throw measurementError(
        "OBS_METRIC_MISSING_ATTRIBUTE",
        "record",
        alias,
        definition.name,
        `Metric "${definition.name}" is missing declared attribute "${attributeName}". Provide every declared attribute.`,
        attributeName,
      );
    }
  }
  for (const [attributeName, value] of Object.entries(input)) {
    const attributeDefinition = definition.attributes.get(attributeName);
    if (attributeDefinition === undefined) {
      throw measurementError(
        "OBS_METRIC_UNDECLARED_ATTRIBUTE",
        "record",
        alias,
        definition.name,
        `Metric "${definition.name}" does not declare attribute "${attributeName}". Remove it or add it to the contract.`,
        attributeName,
      );
    }
    if (!isFiniteMetricScalar(value)) {
      throw measurementError(
        "OBS_METRIC_INVALID_VALUE",
        "record",
        alias,
        definition.name,
        `Metric "${definition.name}" attribute "${attributeName}" must be a finite scalar value.`,
        attributeName,
      );
    }
    const allowedValues = attributeDefinition.allowedValues;
    if (
      allowedValues !== undefined &&
      !allowedValues.some(
        (allowed) => metricScalarIdentity(allowed) === metricScalarIdentity(value),
      )
    ) {
      throw measurementError(
        "OBS_METRIC_VALUE_NOT_ALLOWED",
        "record",
        alias,
        definition.name,
        `Metric "${definition.name}" attribute "${attributeName}" is outside its declared allowed values. Use a declared value.`,
        attributeName,
      );
    }
    attributes.push({ key: attributeName, value });
  }
  return attributes;
};

const cardinalityLimits = (definition: CompiledMetricDefinition) =>
  Array.from(definition.attributes, ([attributeName, attribute]) => ({
    attributeName,
    maximumCardinality: attribute.maximumCardinality,
  }));

const counterHandle = (
  metrics: Metrics,
  alias: string,
  definition: Extract<CompiledMetricDefinition, { readonly kind: "counter" }>,
) => {
  const counter: Counter = metrics.counter(definition);
  return {
    add: (value: number, input: { readonly [name: string]: MetricAttributeValue }) => {
      const attributes = parseContractAttributes(alias, definition, input);
      const commit = prepareContractMetricAttributes(
        metrics,
        alias,
        definition.name,
        attributes,
        cardinalityLimits(definition),
      );
      counter.add(value, attributes);
      commit();
    },
  };
};

const histogramHandle = (
  metrics: Metrics,
  alias: string,
  definition: Extract<CompiledMetricDefinition, { readonly kind: "histogram" }>,
) => {
  const histogram: Histogram = metrics.histogram(definition);
  return {
    record: (value: number, input: { readonly [name: string]: MetricAttributeValue }) => {
      const attributes = parseContractAttributes(alias, definition, input);
      const commit = prepareContractMetricAttributes(
        metrics,
        alias,
        definition.name,
        attributes,
        cardinalityLimits(definition),
      );
      histogram.record(value, attributes);
      commit();
    },
  };
};

export const makeMetricProducer = <const Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  metrics: Metrics,
): MetricProducer<Definition> => ({
  counter: (alias) => {
    const definition = resolveDefinition(contract, alias, "counter");
    return counterHandle(metrics, alias, definition);
  },
  histogram: (alias) => {
    const definition = resolveDefinition(contract, alias, "histogram");
    return histogramHandle(metrics, alias, definition);
  },
  observableGauge: (alias, callback) => {
    const definition = resolveDefinition(contract, alias, "observable_gauge");
    return metrics.observableGauge(definition, () =>
      callback().map((observation) => {
        const attributes = parseContractAttributes(alias, definition, observation.attributes);
        const commit = prepareContractMetricAttributes(
          metrics,
          alias,
          definition.name,
          attributes,
          cardinalityLimits(definition),
        );
        return registerContractGaugeObservation({ value: observation.value, attributes }, commit);
      }),
    );
  },
});
