import { Effect, Layer, Random, Ref } from "effect";
import {
  TelemetryEventSink,
  type EventPayloadOf,
  type EventProducer,
  type TelemetryContract,
  type TelemetryContractInput,
} from "../contract/index.ts";
import type {
  ContractIssueCode,
  TelemetryEventErrorCode,
} from "../contract/TelemetryContractError.ts";
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

export const contractIssueFixtures: ReadonlyArray<ContractIssueCode> = [
  "OBS_CONTRACT_INVALID_VERSION",
  "OBS_CONTRACT_INVALID_EVENT_NAME",
  "OBS_CONTRACT_DUPLICATE_EVENT_NAME",
  "OBS_CONTRACT_INVALID_EVENT_KIND",
  "OBS_CONTRACT_INVALID_ATTRIBUTE_NAME",
  "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
  "OBS_CONTRACT_INVALID_SAMPLING_RATE",
  "OBS_CONTRACT_INVALID_AUDIT_ACTION",
];

export const telemetryEventErrorFixtures: ReadonlyArray<TelemetryEventErrorCode> = [
  "OBS_EVENT_UNKNOWN_NAME",
  "OBS_EVENT_UNDECLARED_ATTRIBUTE",
  "OBS_EVENT_MISSING_ATTRIBUTE",
  "OBS_EVENT_INVALID_FIELD",
  "OBS_EVENT_INVALID_OUTCOME",
];

export type CollectingTelemetryEventSink = {
  readonly layer: Layer.Layer<TelemetryEventSink>;
  readonly events: Effect.Effect<ReadonlyArray<TelemetryEvent>>;
};

export const makeCollectingTelemetryEventSink = Effect.fn("makeCollectingTelemetryEventSink")(
  function* (): Effect.fn.Return<CollectingTelemetryEventSink> {
    const store = yield* Ref.make<ReadonlyArray<TelemetryEvent>>([]);
    const record = (event: TelemetryEvent): Effect.Effect<void> =>
      Ref.update(store, (events) => [...events, event]);
    return {
      layer: Layer.succeed(TelemetryEventSink, TelemetryEventSink.of({ record })),
      events: Ref.get(store),
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
