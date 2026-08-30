import { Effect, Layer, Random, Ref } from "effect";
import {
  TelemetryEventSink,
  type BrowserTelemetryEvent,
  type EventPayloadOf,
  type EventProducer,
  type TelemetryContract,
  type TelemetryContractInput,
} from "../contract/index.ts";
import { defineMetricDefinitions, type MetricKind } from "../contract/MetricDefinition.ts";
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

export const metricDefinitionFixtures = defineMetricDefinitions({
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
});

export type InvalidMetricDefinitionFixture = {
  readonly kind: MetricKind;
  readonly issue: ContractIssueCode;
};

export const invalidMetricDefinitionFixtures: ReadonlyArray<InvalidMetricDefinitionFixture> = [
  { kind: "counter", issue: "OBS_CONTRACT_INVALID_METRIC_BOUNDARIES" },
  { kind: "histogram", issue: "OBS_CONTRACT_INVALID_METRIC_BOUNDARIES" },
  { kind: "observable_gauge", issue: "OBS_CONTRACT_INVALID_METRIC_BOUNDARIES" },
];

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
    const recordBrowserBatch = (
      events: ReadonlyArray<BrowserTelemetryEvent>,
    ): Effect.Effect<void> => Ref.update(browserStore, (captured) => [...captured, ...events]);
    return {
      layer: Layer.succeed(
        TelemetryEventSink,
        TelemetryEventSink.of({ record, recordBrowserBatch }),
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
