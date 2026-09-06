import { Option } from "effect";
import type { CorrelationContext } from "../Correlation.ts";
import type { AttributeValue } from "../contract/TelemetryEvent.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import { sanitizeText, transformSignalFields, type PolicyDecision } from "./PolicyTransform.ts";

export type DefectEnvelope = {
  readonly errorType: "UnexpectedDefect";
  readonly errorMessage: string;
  readonly stack: Option.Option<string>;
  readonly fingerprint: ReadonlyArray<string>;
  readonly tags: ReadonlyMap<string, string>;
  readonly context: ReadonlyMap<string, AttributeValue>;
  readonly correlation: CorrelationContext;
};

export const sanitizeDefectEnvelope = (
  policy: DataPolicy,
  envelope: DefectEnvelope,
): PolicyDecision<Option.Option<DefectEnvelope>> => {
  const contextInput: { [key: string]: AttributeValue } = {};
  for (const [key, value] of envelope.context) contextInput[key] = value;
  const contextDecision = transformSignalFields(policy, "defect", contextInput);
  const context = new Map<string, AttributeValue>();
  for (const [key, value] of Object.entries(contextDecision.value)) context.set(key, value);
  const tagsInput: { [key: string]: string } = {};
  for (const [key, value] of envelope.tags) tagsInput[key] = value;
  const tagsDecision = transformSignalFields(policy, "defect", tagsInput);
  const tags = new Map<string, string>();
  for (const [key, value] of Object.entries(tagsDecision.value)) tags.set(key, String(value));
  const redactions = [...contextDecision.redactions, ...tagsDecision.redactions];
  const dropped = contextDecision.dropped + tagsDecision.dropped;
  if (
    redactions.some(
      (redaction) => redaction.rule === "classification" && redaction.action === "dropped",
    )
  ) {
    return { value: Option.none(), redactions, dropped };
  }
  const value = {
    ...envelope,
    errorType: envelope.errorType,
    errorMessage: sanitizeText(policy, envelope.errorMessage, "defect"),
    stack: Option.map(envelope.stack, (stack) => sanitizeText(policy, stack, "defect")),
    fingerprint: envelope.fingerprint.map((part) => sanitizeText(policy, part, "defect")),
    tags,
    context,
  } satisfies DefectEnvelope;
  return { value: Option.some(value), redactions, dropped };
};
