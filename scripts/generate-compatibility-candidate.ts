import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Schema } from "effect";
import { browserEnvelopeMetadata } from "../packages/telemetry/src/BrowserEvents.ts";
import type { Contract } from "../packages/telemetry/src/index.ts";
import { encodeCompatibilityJson } from "./compatibility-json.ts";

const ContractIndexDocument = Schema.Struct({
  index: Schema.Literal(1),
  contractVersion: Schema.Int,
  service: Schema.String,
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.Literals(["request", "operation", "domain", "defect", "audit"]),
      attributes: Schema.Array(Schema.String),
      attributeClassifications: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          classification: Schema.Literals(["public", "internal", "sensitive", "forbidden"]),
        }),
      ),
    }),
  ),
  metrics: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.Literals(["counter", "histogram", "observable_gauge"]),
      unit: Schema.String,
      attributes: Schema.Array(Schema.String),
    }),
  ),
  aliases: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["event", "metric"]),
      from: Schema.String,
      to: Schema.String,
    }),
  ),
});

const decodeContractIndex = Schema.decodeUnknownSync(ContractIndexDocument, {
  onExcessProperty: "error",
});

const outcomeMeaning = (kind: Contract.EventKind): ReadonlyArray<string> =>
  kind === "defect"
    ? ["failure"]
    : kind === "audit"
      ? ["cancelled", "denied", "failure", "success"]
      : ["cancelled", "failure", "success"];

const aliasDate = (): string =>
  execFileSync("git", ["log", "-1", "--format=%cs", "--", "observability/contract.json"], {
    encoding: "utf8",
  }).trim();

const retentionWindowDays = (): number => {
  const operations = readFileSync("observability/operations.yaml", "utf8");
  const days = [...operations.matchAll(/^\s+days:\s+(\d+)$/gm)].map((match) => Number(match[1]));
  if (days.length === 0 || days.some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error("Operations retention must contain positive safe integer days.");
  return Math.max(...days);
};

export const generateCompatibilityCandidate = async (): Promise<string> => {
  const contract = decodeContractIndex(
    JSON.parse(readFileSync("observability/contract.json", "utf8")),
  );
  const since = aliasDate();
  const surface: Contract.ContractSurface = {
    surface: 1,
    service: contract.service,
    contractVersion: contract.contractVersion,
    events: contract.events.map((event) => ({
      name: event.name,
      kind: event.kind,
      outcomeMeaning: outcomeMeaning(event.kind),
      attributes: event.attributes.map((name) => ({
        name,
        required: false,
        classification:
          event.attributeClassifications.find((entry) => entry.name === name)?.classification ??
          "internal",
        metricLabel: false,
      })),
    })),
    metrics: contract.metrics.map((metric) => ({
      name: metric.name,
      kind: metric.kind,
      unit: metric.unit,
      boundaries: [],
      attributes: metric.attributes.map((name) => ({
        name,
        classification: "internal",
        maximumCardinality: 0,
        allowedValues: [],
      })),
    })),
    auditActions: [],
    aliases: contract.aliases.map((alias) => ({ ...alias, since })),
    browserEnvelope: browserEnvelopeMetadata,
    retentionWindowDays: retentionWindowDays(),
  };
  return encodeCompatibilityJson(surface);
};

if (import.meta.main) {
  writeFileSync(
    "observability/compatibility/candidate.json",
    await generateCompatibilityCandidate(),
  );
}
