import { writeFileSync } from "node:fs";
import type { Contract } from "../packages/telemetry/src/index.ts";
import {
  packageSurfaceDigest,
  publishedPackageSurface,
  type CompatibilityBaselineArtifact,
} from "./compatibility-gate.ts";
import { encodeCompatibilityJson } from "./compatibility-json.ts";

const tag = "v0.2.1";
const commit = "a5ab6997536f9d3af797429783f65c9e68a0dfa0";

const references = [
  { name: "@equipe-tech/observability", version: "0.2.1" },
  { name: "@equipe-tech/observability-cli", version: "0.2.1" },
];

const contract: Contract.ContractSurface = {
  surface: 1,
  service: "observability",
  contractVersion: 1,
  events: [],
  metrics: [],
  auditActions: [],
  aliases: [],
  browserEnvelope: {
    version: 1,
    batchFields: ["events", "version"],
    eventFields: ["fields", "id", "name", "occurredAt"],
  },
  retentionWindowDays: 30,
};

const published = await Promise.all(
  references.map((reference) => publishedPackageSurface(reference.name, reference.version)),
);
const baseline: CompatibilityBaselineArtifact = {
  baseline: 1,
  source: {
    tag,
    commit,
    registryPackages: published.map((entry) => entry.artifact),
  },
  contract,
  packages: published.map((entry) => ({
    ...entry.surface,
    surfaceDigest: packageSurfaceDigest(entry.surface),
  })),
};
writeFileSync("observability/compatibility/baseline.json", encodeCompatibilityJson(baseline));
