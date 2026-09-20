import { Effect, Option } from "effect";
import {
  AdapterName,
  registerOfficialAdapter,
  type OfficialAdapterRegistration,
} from "../profile/ObservabilityAdapter.ts";
import { layerWideEvent } from "./WideEventSink.ts";

export type EffectEventsAdapter = {
  readonly registration: OfficialAdapterRegistration;
};

export const effectEventsAdapterName = AdapterName.make("effect-events");

export const effectEventsAdapter = (): EffectEventsAdapter => ({
  registration: registerOfficialAdapter({
    name: effectEventsAdapterName,
    capability: "events",
    stage: "server",
    start: () =>
      Effect.succeed({
        flush: Effect.void,
        close: Effect.void,
        eventLayer: Option.some(layerWideEvent),
        auditLayer: Option.none(),
        degraded: () => false,
      }),
  }),
});
