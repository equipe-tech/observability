import { Schema } from "effect";

export const AxiomDatasetRetentionDays = Schema.Int.pipe(Schema.optionalKey);

type AxiomDatasetRetention = {
  readonly retentionDays?: number;
  readonly useRetentionPeriod: boolean;
};

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
