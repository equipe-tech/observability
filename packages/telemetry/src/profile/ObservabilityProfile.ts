import { Schema } from "effect";

export const ProfileName = Schema.Literals(["nestjs-api", "worker", "react-web", "cli", "library"]);
export type ProfileName = typeof ProfileName.Type;

export const ProfileRuntime = Schema.Literals(["node-global", "browser-global", "none"]);
export type ProfileRuntime = typeof ProfileRuntime.Type;

export const AdapterCapability = Schema.Literals([
  "events",
  "traces",
  "metrics",
  "defects",
  "browser-ingest",
]);
export type AdapterCapability = typeof AdapterCapability.Type;

export const ExternalAdapterCapability = Schema.Literals(["events", "defects", "browser-ingest"]);
export type ExternalAdapterCapability = typeof ExternalAdapterCapability.Type;

export const CapabilityRequirement = Schema.Literals([
  "required",
  "required-in-production",
  "optional",
  "forbidden",
]);
export type CapabilityRequirement = typeof CapabilityRequirement.Type;

export const LifecycleStage = Schema.Literals(["server", "metrics", "browser"]);
export type LifecycleStage = typeof LifecycleStage.Type;

export type ObservabilityProfile = {
  readonly name: ProfileName;
  readonly runtime: ProfileRuntime;
  readonly events: CapabilityRequirement;
  readonly traces: CapabilityRequirement;
  readonly metrics: CapabilityRequirement;
  readonly defects: CapabilityRequirement;
  readonly browserIngest: CapabilityRequirement;
  readonly stages: ReadonlyArray<LifecycleStage>;
  readonly stageDeadlineMillis: ReadonlyMap<LifecycleStage, number>;
  readonly capabilityOrder: ReadonlyMap<LifecycleStage, ReadonlyArray<AdapterCapability>>;
  readonly shutdownDeadlineMillis: number;
};

const profile = (value: ObservabilityProfile): ObservabilityProfile =>
  Object.freeze({ ...value, stages: Object.freeze([...value.stages]) });

export const nestjsApiProfile = profile({
  name: "nestjs-api",
  runtime: "node-global",
  events: "required",
  traces: "required",
  metrics: "required",
  defects: "required-in-production",
  browserIngest: "optional",
  stages: ["server", "metrics"],
  stageDeadlineMillis: new Map([
    ["server", 5_000],
    ["metrics", 3_000],
  ]),
  capabilityOrder: new Map([
    ["server", ["browser-ingest", "events", "traces", "defects"]],
    ["metrics", ["metrics"]],
  ]),
  shutdownDeadlineMillis: 5_000,
});

export const workerProfile = profile({
  name: "worker",
  runtime: "node-global",
  events: "required",
  traces: "required",
  metrics: "required",
  defects: "required-in-production",
  browserIngest: "forbidden",
  stages: ["server", "metrics"],
  stageDeadlineMillis: new Map([
    ["server", 5_000],
    ["metrics", 3_000],
  ]),
  capabilityOrder: new Map([
    ["server", ["events", "traces", "defects"]],
    ["metrics", ["metrics"]],
  ]),
  shutdownDeadlineMillis: 5_000,
});

export const reactWebProfile = profile({
  name: "react-web",
  runtime: "browser-global",
  events: "required",
  traces: "required",
  metrics: "optional",
  defects: "required-in-production",
  browserIngest: "required",
  stages: ["browser"],
  stageDeadlineMillis: new Map([["browser", 2_000]]),
  capabilityOrder: new Map([
    ["browser", ["browser-ingest", "events", "traces", "defects", "metrics"]],
  ]),
  shutdownDeadlineMillis: 2_000,
});

export const cliProfile = profile({
  name: "cli",
  runtime: "node-global",
  events: "required",
  traces: "optional",
  metrics: "optional",
  defects: "optional",
  browserIngest: "forbidden",
  stages: ["server", "metrics"],
  stageDeadlineMillis: new Map([
    ["server", 5_000],
    ["metrics", 3_000],
  ]),
  capabilityOrder: new Map([
    ["server", ["events", "traces", "defects"]],
    ["metrics", ["metrics"]],
  ]),
  shutdownDeadlineMillis: 5_000,
});

export const libraryProfile = profile({
  name: "library",
  runtime: "none",
  events: "forbidden",
  traces: "forbidden",
  metrics: "forbidden",
  defects: "forbidden",
  browserIngest: "forbidden",
  stages: [],
  stageDeadlineMillis: new Map(),
  capabilityOrder: new Map(),
  shutdownDeadlineMillis: 0,
});

export const observabilityProfiles: ReadonlyMap<ProfileName, ObservabilityProfile> = new Map([
  [nestjsApiProfile.name, nestjsApiProfile],
  [workerProfile.name, workerProfile],
  [reactWebProfile.name, reactWebProfile],
  [cliProfile.name, cliProfile],
  [libraryProfile.name, libraryProfile],
]);

export const profileCapabilityRequirement = (
  value: ObservabilityProfile,
  capability: AdapterCapability,
): CapabilityRequirement => {
  switch (capability) {
    case "events":
      return value.events;
    case "traces":
      return value.traces;
    case "metrics":
      return value.metrics;
    case "defects":
      return value.defects;
    case "browser-ingest":
      return value.browserIngest;
  }
};
