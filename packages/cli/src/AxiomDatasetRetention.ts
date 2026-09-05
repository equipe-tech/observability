import { Schema } from "effect";

export const AxiomDatasetRetentionDays = Schema.Int.pipe(Schema.optionalKey);

export type AxiomDatasetRetention = {
  readonly retentionDays?: number;
  readonly useRetentionPeriod: boolean;
};

type AxiomRetentionPreservation =
  | { readonly kind: "unbounded" }
  | { readonly kind: "finite"; readonly days: number }
  | { readonly kind: "unknown" };

const retentionPreservation = (retention: AxiomDatasetRetention): AxiomRetentionPreservation => {
  if (!retention.useRetentionPeriod) return { kind: "unbounded" };
  if (retention.retentionDays === undefined) return { kind: "unknown" };
  return { kind: "finite", days: retention.retentionDays };
};

export const classifyAxiomRetentionChange = (
  observed: ReadonlyArray<AxiomDatasetRetention>,
  desiredDays: number,
): "manual" | "destructive" =>
  observed.some((retention) => {
    const preservation = retentionPreservation(retention);
    return preservation.kind !== "finite" || preservation.days > desiredDays;
  })
    ? "destructive"
    : "manual";

export const AxiomDatasetRetentionInvariant = Schema.makeFilter<AxiomDatasetRetention>(
  (retention) =>
    retention.useRetentionPeriod
      ? retention.retentionDays !== undefined && retention.retentionDays > 0
      : retention.retentionDays === undefined || retention.retentionDays === 0,
  {
    expected:
      "provider-default retention with zero or omitted days, or custom retention with positive days",
  },
);
