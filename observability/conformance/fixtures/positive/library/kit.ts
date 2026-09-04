import { Effect } from "effect";
import {
  Contract,
  defineTelemetryContract,
  type DataPolicyInput,
  type TelemetryContractInput,
} from "@equipe-tech/observability";
import { packageBoundaryConformance } from "@equipe-tech/observability-cli/testing";
import {
  contractConformance,
  libraryLifecycleConformance,
  profileConformance,
  runConformance,
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { fileURLToPath } from "node:url";

export const libraryContractInput = Contract.telemetryContractDefinition({
  version: 1,
  events: {},
  metrics: {
    LibraryOperations: {
      name: "library.operations",
      description: "Reusable library operations",
      unit: "1",
      kind: "counter",
      attributes: {
        "library.operation": { classification: "internal", maximumCardinality: 8 },
      },
    },
  },
  auditActions: {},
});

export const libraryPolicy: DataPolicyInput = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
};

const runtimeRegistrySymbols = [
  "@equipe-tech/observability-react/active-hosts",
] as const;

export const libraryRuntimeMarkerProbe = (): ReadonlyArray<string> => {
  const markers: Array<string> = [];
  for (const symbol of runtimeRegistrySymbols) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for(symbol));
    if (descriptor === undefined) continue;
    if (descriptor.value instanceof WeakSet) continue;
    markers.push(symbol);
  }
  return markers;
};

export const runLibraryFixture = async (): Promise<ConformanceProfileReport> => {
  await Effect.runPromise(defineTelemetryContract(libraryContractInput));
  const target: ConformanceTarget = {
    name: "fixture-library",
    profile: "library",
    environment: "test",
    topology: "local",
    capabilities: { traces: false, metrics: false, defects: false, browserIngest: false, audit: false },
    providers: [
      profileConformance({
        profile: "library",
        service: { name: "fixture-library", version: "1.4.0", environment: "test" },
      }),
      contractConformance({ contract: libraryContractInput }),
      libraryLifecycleConformance({ runtimeMarkers: libraryRuntimeMarkerProbe() }),
      packageBoundaryConformance({
        projectRoot: fileURLToPath(new URL(".", import.meta.url)),
        sourceRoots: ["."],
      }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};
