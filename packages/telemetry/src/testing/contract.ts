import { Effect, Layer, Random, Ref } from "effect";
import {
  TelemetryEventSink,
  type BrowserTelemetryEvent,
  type EventPayloadOf,
  type EventProducer,
  type TelemetryContract,
  type TelemetryContractInput,
} from "../contract/index.ts";
import type { MetricDefinitionsInput } from "../contract/MetricDefinition.ts";
import { ContractIssueCode, TelemetryEventErrorCode } from "../contract/TelemetryContractError.ts";
import type { TelemetryEvent } from "../contract/TelemetryEvent.ts";
import { organizationEvents } from "../contract/OrganizationEvents.ts";

export type OrganizationEventFixture = {
  readonly alias: string;
  readonly name: string;
  readonly kind: string;
};

export const organizationEventFixtures: ReadonlyArray<OrganizationEventFixture> = Object.entries(
  organizationEvents,
).map(([alias, definition]) => ({ alias, name: definition.name, kind: definition.kind }));

export const contractIssueFixtures = ContractIssueCode.literals;

export const telemetryEventErrorFixtures = TelemetryEventErrorCode.literals;

export const metricDefinitionFixtures = {
  Counter: {
    name: "fixture.counter",
    description: "Counter fixture",
    unit: "1",
    kind: "counter",
    attributes: {},
  },
  Histogram: {
    name: "fixture.histogram",
    description: "Histogram fixture",
    unit: "ms",
    kind: "histogram",
    boundaries: [1, 10],
    attributes: {},
  },
  ObservableGauge: {
    name: "fixture.gauge",
    description: "Observable gauge fixture",
    unit: "1",
    kind: "observable_gauge",
    attributes: {},
  },
} satisfies MetricDefinitionsInput;

type MetricDefinitionIssueCode = Extract<
  ContractIssueCode,
  `OBS_CONTRACT_${string}METRIC${string}`
>;

export type InvalidMetricDefinitionFixture = {
  readonly issue: MetricDefinitionIssueCode;
  readonly metricsDocument: string;
};

const exhaustiveMetricDefinitionFixtures = <
  Fixtures extends ReadonlyArray<InvalidMetricDefinitionFixture>,
>(
  fixtures: Exclude<MetricDefinitionIssueCode, Fixtures[number]["issue"]> extends never
    ? Fixtures
    : never,
): Fixtures => fixtures;

export const invalidMetricDefinitionFixtures = exhaustiveMetricDefinitionFixtures([
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_NAME",
    metricsDocument: `{"Metric":{"name":"invalid","description":"Fixture","unit":"1","kind":"counter","attributes":{}}}`,
  },
  {
    issue: "OBS_CONTRACT_DUPLICATE_METRIC_NAME",
    metricsDocument: `{"First":{"name":"fixture.duplicate","description":"Fixture","unit":"1","kind":"counter","attributes":{}},"Second":{"name":"fixture.duplicate","description":"Fixture","unit":"1","kind":"counter","attributes":{}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_KIND",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"1","kind":"summary","attributes":{}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_DESCRIPTION",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"","unit":"1","kind":"counter","attributes":{}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_UNIT",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"bad unit","kind":"counter","attributes":{}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_BOUNDARIES",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"ms","kind":"histogram","boundaries":[],"attributes":{}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_ATTRIBUTE_NAME",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"1","kind":"counter","attributes":{"Invalid":{"classification":"public","maximumCardinality":1}}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_ATTRIBUTE_DEFINITION",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"1","kind":"counter","attributes":{"fixture.label":{"classification":"sensitive","maximumCardinality":1}}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_CARDINALITY",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"1","kind":"counter","attributes":{"fixture.label":{"classification":"public","maximumCardinality":0}}}}`,
  },
  {
    issue: "OBS_CONTRACT_INVALID_METRIC_ALLOWED_VALUES",
    metricsDocument: `{"Metric":{"name":"fixture.metric","description":"Fixture","unit":"1","kind":"counter","attributes":{"fixture.label":{"classification":"public","maximumCardinality":1,"allowedValues":[]}}}}`,
  },
]);

export type CollectingTelemetryEventSink = {
  readonly layer: Layer.Layer<TelemetryEventSink>;
  readonly events: Effect.Effect<ReadonlyArray<TelemetryEvent>>;
  readonly browserEvents: Effect.Effect<ReadonlyArray<BrowserTelemetryEvent>>;
};

export const makeCollectingTelemetryEventSink = Effect.fn("makeCollectingTelemetryEventSink")(
  function* (): Effect.fn.Return<CollectingTelemetryEventSink> {
    const store = yield* Ref.make<ReadonlyArray<TelemetryEvent>>([]);
    const browserStore = yield* Ref.make<ReadonlyArray<BrowserTelemetryEvent>>([]);
    const record = (event: TelemetryEvent): Effect.Effect<void> =>
      Ref.update(store, (events) => [...events, event]);
    const admitBrowserBatch = (
      events: ReadonlyArray<BrowserTelemetryEvent>,
    ): Effect.Effect<{ readonly commit: Effect.Effect<void> }> =>
      Effect.succeed({
        commit: Ref.update(browserStore, (captured) => [...captured, ...events]),
      });
    return {
      layer: Layer.succeed(
        TelemetryEventSink,
        TelemetryEventSink.of({ record, admitBrowserBatch }),
      ),
      events: Ref.get(store),
      browserEvents: Ref.get(browserStore),
    };
  },
);

export const withFixedSampling = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  draw: number,
): Effect.Effect<A, E, R> =>
  Effect.provideService(program, Random.Random, {
    nextIntUnsafe: () => 0,
    nextDoubleUnsafe: () => draw,
  });

export type { EventPayloadOf, EventProducer, TelemetryContract, TelemetryContractInput };
