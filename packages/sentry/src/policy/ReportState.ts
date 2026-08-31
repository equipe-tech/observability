import { Option } from "effect";
import type { SentryDefectReport, SentryReportReasonCounts } from "./DefectProjection.ts";

export type SentryOutcomeReason = keyof SentryReportReasonCounts;

export type SentryReportState = {
  readonly increment: (reason: SentryOutcomeReason) => void;
  readonly report: () => SentryDefectReport;
};

export const sentryReportState = (): SentryReportState => {
  const reasons = {
    disabled: 0,
    policy: 0,
    identity: 0,
    fingerprint: 0,
    captured: 0,
    closed: 0,
    transport: 0,
    flushIncomplete: 0,
  };
  let total = 0;
  let firstOutcomeAt = Option.none<string>();
  let lastOutcomeAt = Option.none<string>();
  return {
    increment: (reason) => {
      const timestamp = new Date().toISOString();
      reasons[reason] += 1;
      total += 1;
      if (Option.isNone(firstOutcomeAt)) firstOutcomeAt = Option.some(timestamp);
      lastOutcomeAt = Option.some(timestamp);
    },
    report: () => ({ total, firstOutcomeAt, lastOutcomeAt, reasons: { ...reasons } }),
  };
};
