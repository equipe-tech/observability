export type ProfileName = "nestjs-api" | "worker" | "react-web" | "cli" | "library";

export type AdapterCapability = "events" | "traces" | "metrics" | "defects" | "browser-ingest";

export type ExternalAdapterCapability = "events" | "defects" | "browser-ingest";

export type CapabilityRequirement =
  | "required"
  | "required-in-production"
  | "optional"
  | "forbidden";

export type LifecycleStage = "server" | "metrics" | "browser";

type ProfileCapabilities = {
  readonly name: ProfileName;
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

export type NodeObservabilityProfile = ProfileCapabilities & { readonly runtime: "node-global" };
export type BrowserObservabilityProfile = ProfileCapabilities & {
  readonly runtime: "browser-global";
};
export type LibraryObservabilityProfile = ProfileCapabilities & { readonly runtime: "none" };
export type ObservabilityProfile =
  | NodeObservabilityProfile
  | BrowserObservabilityProfile
  | LibraryObservabilityProfile;

const nodeProfile = (value: NodeObservabilityProfile): NodeObservabilityProfile =>
  Object.freeze({ ...value, stages: Object.freeze([...value.stages]) });

const browserProfile = (value: BrowserObservabilityProfile): BrowserObservabilityProfile =>
  Object.freeze({ ...value, stages: Object.freeze([...value.stages]) });

const libraryProfileDescriptor = (
  value: LibraryObservabilityProfile,
): LibraryObservabilityProfile =>
  Object.freeze({ ...value, stages: Object.freeze([...value.stages]) });

export const nestjsApiProfile = nodeProfile({
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

export const workerProfile = nodeProfile({
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

export const reactWebProfile = browserProfile({
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

export const cliProfile = nodeProfile({
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

export const libraryProfile = libraryProfileDescriptor({
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

export const observabilityProfiles: ReadonlyMap<ProfileName, ObservabilityProfile> = new Map<
  ProfileName,
  ObservabilityProfile
>([
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

export const profileCapabilityRank = (
  profile: ObservabilityProfile,
  stage: LifecycleStage,
  capability: AdapterCapability,
): number => profile.capabilityOrder.get(stage)?.indexOf(capability) ?? Number.MAX_SAFE_INTEGER;
