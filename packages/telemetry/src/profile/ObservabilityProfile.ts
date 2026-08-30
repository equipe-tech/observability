export type ProfileName = "nestjs-api" | "worker" | "react-web" | "cli" | "library";

export type AdapterCapability = "events" | "traces" | "metrics" | "defects" | "browser-ingest";

export type ExternalAdapterCapability = "events" | "defects" | "browser-ingest";

export type CapabilityRequirement =
  | "required"
  | "required-in-production"
  | "optional"
  | "forbidden";

export type LifecycleStage = "server" | "metrics" | "browser";

type StageDeadline = readonly [stage: LifecycleStage, deadlineMillis: number];
type StageCapabilityOrder = readonly [
  stage: LifecycleStage,
  capabilities: ReadonlyArray<AdapterCapability>,
];

type ProfileCapabilities = {
  readonly name: ProfileName;
  readonly events: CapabilityRequirement;
  readonly traces: CapabilityRequirement;
  readonly metrics: CapabilityRequirement;
  readonly defects: CapabilityRequirement;
  readonly browserIngest: CapabilityRequirement;
  readonly stages: ReadonlyArray<LifecycleStage>;
  readonly stageDeadlineMillis: ReadonlyArray<StageDeadline>;
  readonly capabilityOrder: ReadonlyArray<StageCapabilityOrder>;
  readonly shutdownDeadlineMillis: number;
};

export type NodeObservabilityProfile = ProfileCapabilities & { readonly runtime: "node-global" };
export type BrowserObservabilityProfile = ProfileCapabilities & {
  readonly runtime: "browser-global";
};
export type LibraryObservabilityProfile = ProfileCapabilities & { readonly runtime: "none" };
export type ObservabilityProfile =
  | NodeObservabilityProfile
  | BrowserObservabilityProfile
  | LibraryObservabilityProfile;

const stageDeadline = (stage: LifecycleStage, deadlineMillis: number): StageDeadline =>
  Object.freeze([stage, deadlineMillis]);

const stageCapabilities = (
  stage: LifecycleStage,
  capabilities: ReadonlyArray<AdapterCapability>,
): StageCapabilityOrder => Object.freeze([stage, Object.freeze([...capabilities])]);

const nodeProfile = (value: NodeObservabilityProfile): NodeObservabilityProfile =>
  Object.freeze({
    ...value,
    stages: Object.freeze([...value.stages]),
    stageDeadlineMillis: Object.freeze([...value.stageDeadlineMillis]),
    capabilityOrder: Object.freeze([...value.capabilityOrder]),
  });

const browserProfile = (value: BrowserObservabilityProfile): BrowserObservabilityProfile =>
  Object.freeze({
    ...value,
    stages: Object.freeze([...value.stages]),
    stageDeadlineMillis: Object.freeze([...value.stageDeadlineMillis]),
    capabilityOrder: Object.freeze([...value.capabilityOrder]),
  });

const libraryProfileDescriptor = (
  value: LibraryObservabilityProfile,
): LibraryObservabilityProfile =>
  Object.freeze({
    ...value,
    stages: Object.freeze([...value.stages]),
    stageDeadlineMillis: Object.freeze([...value.stageDeadlineMillis]),
    capabilityOrder: Object.freeze([...value.capabilityOrder]),
  });

export const nestjsApiProfile = nodeProfile({
  name: "nestjs-api",
  runtime: "node-global",
  events: "required",
  traces: "required",
  metrics: "required",
  defects: "required-in-production",
  browserIngest: "optional",
  stages: ["server", "metrics"],
  stageDeadlineMillis: [stageDeadline("server", 5_000), stageDeadline("metrics", 3_000)],
  capabilityOrder: [
    stageCapabilities("server", ["browser-ingest", "events", "traces", "defects"]),
    stageCapabilities("metrics", ["metrics"]),
  ],
  shutdownDeadlineMillis: 5_000,
});

export const workerProfile = nodeProfile({
  name: "worker",
  runtime: "node-global",
  events: "required",
  traces: "required",
  metrics: "required",
  defects: "required-in-production",
  browserIngest: "forbidden",
  stages: ["server", "metrics"],
  stageDeadlineMillis: [stageDeadline("server", 5_000), stageDeadline("metrics", 3_000)],
  capabilityOrder: [
    stageCapabilities("server", ["events", "traces", "defects"]),
    stageCapabilities("metrics", ["metrics"]),
  ],
  shutdownDeadlineMillis: 5_000,
});

export const reactWebProfile = browserProfile({
  name: "react-web",
  runtime: "browser-global",
  events: "required",
  traces: "required",
  metrics: "optional",
  defects: "required-in-production",
  browserIngest: "required",
  stages: ["browser"],
  stageDeadlineMillis: [stageDeadline("browser", 2_000)],
  capabilityOrder: [
    stageCapabilities("browser", ["browser-ingest", "events", "traces", "defects", "metrics"]),
  ],
  shutdownDeadlineMillis: 2_000,
});

export const cliProfile = nodeProfile({
  name: "cli",
  runtime: "node-global",
  events: "required",
  traces: "optional",
  metrics: "optional",
  defects: "optional",
  browserIngest: "forbidden",
  stages: ["server", "metrics"],
  stageDeadlineMillis: [stageDeadline("server", 5_000), stageDeadline("metrics", 3_000)],
  capabilityOrder: [
    stageCapabilities("server", ["events", "traces", "defects"]),
    stageCapabilities("metrics", ["metrics"]),
  ],
  shutdownDeadlineMillis: 5_000,
});

export const libraryProfile = libraryProfileDescriptor({
  name: "library",
  runtime: "none",
  events: "forbidden",
  traces: "forbidden",
  metrics: "forbidden",
  defects: "forbidden",
  browserIngest: "forbidden",
  stages: [],
  stageDeadlineMillis: [],
  capabilityOrder: [],
  shutdownDeadlineMillis: 0,
});

type ObservabilityProfiles = {
  readonly "nestjs-api": NodeObservabilityProfile;
  readonly worker: NodeObservabilityProfile;
  readonly "react-web": BrowserObservabilityProfile;
  readonly cli: NodeObservabilityProfile;
  readonly library: LibraryObservabilityProfile;
};

export const observabilityProfiles: ObservabilityProfiles = Object.freeze({
  "nestjs-api": nestjsApiProfile,
  worker: workerProfile,
  "react-web": reactWebProfile,
  cli: cliProfile,
  library: libraryProfile,
});

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

export const profileStageDeadlineMillis = (
  profile: ObservabilityProfile,
  stage: LifecycleStage,
): number | undefined =>
  profile.stageDeadlineMillis.find(([candidate]) => candidate === stage)?.[1];

export const profileCapabilityRank = (
  profile: ObservabilityProfile,
  stage: LifecycleStage,
  capability: AdapterCapability,
): number =>
  profile.capabilityOrder.find(([candidate]) => candidate === stage)?.[1].indexOf(capability) ??
  Number.MAX_SAFE_INTEGER;
