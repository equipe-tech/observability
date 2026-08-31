import type { DataPolicy } from "@equipe-tech/observability/policy";
import { Option } from "effect";
import type { DefectDeduplicator } from "./Deduplication.ts";
import {
  parseSentryDefectCapture,
  projectDefect,
  type ProjectionIdentity,
  type PublicStackParser,
  type SentryCaptureOutcome,
  type SentryDefectCapture,
} from "./DefectProjection.ts";
import type { EventSettlements } from "./EventSettlement.ts";
import type { ProjectedSentryEvent } from "./DefectProjection.ts";
import type { SentryReportState } from "./ReportState.ts";

export type CaptureResult = {
  readonly outcome: SentryCaptureOutcome;
  readonly completion?: Promise<boolean>;
};

export type CaptureRuntime = {
  readonly policy: DataPolicy;
  readonly identity: ProjectionIdentity;
  readonly dedupe: DefectDeduplicator;
  readonly settlements: EventSettlements<ProjectedSentryEvent>;
  readonly stackParser: PublicStackParser;
  readonly send: (event: ProjectedSentryEvent) => void;
};

export const captureDefectNow = (
  input: SentryDefectCapture,
  closed: boolean,
  runtime: CaptureRuntime | undefined,
  eventId: () => string,
  reportState: SentryReportState,
): CaptureResult => {
  const parsedInput = parseSentryDefectCapture(input);
  if (closed) {
    reportState.increment("closed");
    return { outcome: { kind: "suppressed", reason: "closed" } };
  }
  if (runtime === undefined) {
    reportState.increment("disabled");
    return { outcome: { kind: "suppressed", reason: "disabled" } };
  }
  const id = eventId();
  const decision = runtime.dedupe.admit(id, parsedInput.envelope, Date.now());
  if (decision.kind === "deduplicated") {
    reportState.increment(decision.reason);
    return { outcome: decision };
  }
  const projected = projectDefect(
    runtime.policy,
    runtime.identity,
    parsedInput.envelope,
    id,
    runtime.stackParser,
  );
  if (Option.isNone(projected)) {
    runtime.dedupe.rollback(id);
    reportState.increment("policy");
    return { outcome: { kind: "suppressed", reason: "policy" } };
  }
  const completion = runtime.settlements.reserve(id, projected.value);
  if (completion === undefined) {
    runtime.dedupe.rollback(id);
    reportState.increment("transport");
    return { outcome: { kind: "failed", reason: "transport" } };
  }
  completion.then(
    (accepted) => reportState.increment(accepted ? "captured" : "transport"),
    () => reportState.increment("transport"),
  );
  try {
    runtime.send(projected.value);
  } catch {
    runtime.settlements.reject(id);
    return { outcome: { kind: "failed", reason: "transport" } };
  }
  return { outcome: { kind: "queued", eventId: id }, completion };
};
