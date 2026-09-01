import { Effect, Schema } from "effect";
import { browserEnvelopeMetadata } from "../BrowserEvents.ts";
import type { AuditOutcome } from "../audit/AuditRecord.ts";
import type {
  AttributeClassification,
  TelemetryContract,
  TelemetryContractInput,
} from "./TelemetryContract.ts";
import type { EventKind } from "./TelemetryEvent.ts";
import type { MetricKind, MetricAttributeScalar } from "./MetricDefinition.ts";
import type { ContractSignalAliasMetadata } from "./ContractIndex.ts";

export type ContractSurfaceEventAttribute = {
  readonly name: string;
  readonly required: boolean;
  readonly classification: AttributeClassification;
  readonly metricLabel: boolean;
};

export type ContractSurfaceEvent = {
  readonly name: string;
  readonly kind: EventKind;
  readonly outcomeMeaning: ReadonlyArray<string>;
  readonly attributes: ReadonlyArray<ContractSurfaceEventAttribute>;
};

export type ContractSurfaceMetricAttribute = {
  readonly name: string;
  readonly classification: "public" | "internal";
  readonly maximumCardinality: number;
  readonly allowedValues: ReadonlyArray<MetricAttributeScalar>;
};

export type ContractSurfaceMetric = {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly boundaries: ReadonlyArray<number>;
  readonly attributes: ReadonlyArray<ContractSurfaceMetricAttribute>;
};

export type ContractSurfaceAuditAction = {
  readonly action: string;
  readonly resourceType: string;
  readonly allowedOutcomes: ReadonlyArray<AuditOutcome>;
  readonly reasonCodes: ReadonlyArray<string>;
};

export type ContractSurfaceAlias = {
  readonly kind: "event" | "metric";
  readonly from: string;
  readonly to: string;
  readonly since: string;
};

export type ContractSurface = {
  readonly surface: 1;
  readonly service: string;
  readonly contractVersion: number;
  readonly events: ReadonlyArray<ContractSurfaceEvent>;
  readonly metrics: ReadonlyArray<ContractSurfaceMetric>;
  readonly auditActions: ReadonlyArray<ContractSurfaceAuditAction>;
  readonly aliases: ReadonlyArray<ContractSurfaceAlias>;
  readonly browserEnvelope: {
    readonly version: number;
    readonly batchFields: ReadonlyArray<string>;
    readonly eventFields: ReadonlyArray<string>;
  };
  readonly retentionWindowDays: number;
};

export type ContractSurfaceInput<Definition extends TelemetryContractInput> = {
  readonly contract: TelemetryContract<Definition>;
  readonly service: string;
  readonly aliases?: ContractSignalAliasMetadata;
  readonly retentionWindowDays: number;
};

const outcomeMeaning = (kind: EventKind): ReadonlyArray<string> =>
  kind === "defect"
    ? ["failure"]
    : kind === "audit"
      ? ["cancelled", "denied", "failure", "success"]
      : ["cancelled", "failure", "success"];

const byName = <Entry extends { readonly name: string }>(left: Entry, right: Entry): number =>
  left.name.localeCompare(right.name);

export const contractSurface = <Definition extends TelemetryContractInput>(
  input: ContractSurfaceInput<Definition>,
): ContractSurface => ({
  surface: 1,
  service: input.service,
  contractVersion: input.contract.version,
  events: [...input.contract.eventByName.values()]
    .map((event) => ({
      name: event.name,
      kind: event.kind,
      outcomeMeaning: outcomeMeaning(event.kind),
      attributes: [...event.attributes.entries()]
        .map(([name, attribute]) => ({
          name,
          required: attribute.required,
          classification: attribute.classification,
          metricLabel: attribute.metricLabel,
        }))
        .sort(byName),
    }))
    .sort(byName),
  metrics: [...input.contract.metricByName.values()]
    .map((metric) => ({
      name: metric.name,
      kind: metric.kind,
      unit: metric.unit,
      boundaries: metric.kind === "histogram" ? [...metric.boundaries] : [],
      attributes: [...metric.attributes.entries()]
        .map(([name, attribute]) => ({
          name,
          classification: attribute.classification,
          maximumCardinality: attribute.maximumCardinality,
          allowedValues: [...(attribute.allowedValues ?? [])],
        }))
        .sort(byName),
    }))
    .sort(byName),
  auditActions: [...input.contract.auditActionByName.values()]
    .map((action) => ({
      action: action.action,
      resourceType: action.resourceType,
      allowedOutcomes: [...action.allowedOutcomes].sort(),
      reasonCodes: [...action.reasonCodes].sort(),
    }))
    .sort((left, right) => left.action.localeCompare(right.action)),
  aliases: [...(input.aliases?.aliases ?? [])]
    .map((alias) => ({
      kind: alias.source.kind,
      from: alias.source.name,
      to: alias.target.name,
      since: alias.since,
    }))
    .sort((left, right) =>
      `${left.kind}\u0000${left.from}\u0000${left.to}`.localeCompare(
        `${right.kind}\u0000${right.from}\u0000${right.to}`,
      ),
    ),
  browserEnvelope: browserEnvelopeMetadata,
  retentionWindowDays: input.retentionWindowDays,
});

const PositiveSafeInteger = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.makeFilter(Number.isSafeInteger, { expected: "a positive safe integer" }),
);
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const EventAttributeDocument = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  classification: Schema.Literals(["public", "internal", "sensitive", "forbidden"]),
  metricLabel: Schema.Boolean,
});
const EventDocument = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["request", "operation", "domain", "defect", "audit"]),
  outcomeMeaning: Schema.Array(Schema.String),
  attributes: Schema.Array(EventAttributeDocument),
});
const MetricAttributeDocument = Schema.Struct({
  name: Schema.String,
  classification: Schema.Literals(["public", "internal"]),
  maximumCardinality: Schema.Int,
  allowedValues: Schema.Array(Scalar),
});
const MetricDocument = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["counter", "histogram", "observable_gauge"]),
  unit: Schema.String,
  boundaries: Schema.Array(Schema.Number),
  attributes: Schema.Array(MetricAttributeDocument),
});
const AuditActionDocument = Schema.Struct({
  action: Schema.String,
  resourceType: Schema.String,
  allowedOutcomes: Schema.Array(Schema.Literals(["success", "failure", "cancelled", "denied"])),
  reasonCodes: Schema.Array(Schema.String),
});
const AliasDocument = Schema.Struct({
  kind: Schema.Literals(["event", "metric"]),
  from: Schema.String,
  to: Schema.String,
  since: Schema.String,
});
export const ContractSurfaceSchema = Schema.Struct({
  surface: Schema.Literal(1),
  service: Schema.String,
  contractVersion: PositiveSafeInteger,
  events: Schema.Array(EventDocument),
  metrics: Schema.Array(MetricDocument),
  auditActions: Schema.Array(AuditActionDocument),
  aliases: Schema.Array(AliasDocument),
  browserEnvelope: Schema.Struct({
    version: PositiveSafeInteger,
    batchFields: Schema.Array(Schema.String),
    eventFields: Schema.Array(Schema.String),
  }),
  retentionWindowDays: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_650)),
});
const decodeDocument = Schema.decodeUnknownEffect(ContractSurfaceSchema, {
  onExcessProperty: "error",
});

export class ContractSurfaceDecodeError extends Schema.TaggedError<ContractSurfaceDecodeError>()(
  "ContractSurfaceDecodeError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const decodeContractSurface = Effect.fn("decodeContractSurface")(function* (
  content: string,
) {
  const document = yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) =>
      new ContractSurfaceDecodeError({ message: "Contract surface is not valid JSON.", cause }),
  });
  return yield* decodeDocument(document).pipe(
    Effect.mapError(
      (cause) =>
        new ContractSurfaceDecodeError({
          message: "Contract surface does not match version 1.",
          cause,
        }),
    ),
  );
});

export const encodeContractSurface = (surface: ContractSurface): string =>
  `${JSON.stringify(surface, null, 2)}\n`;
