import { Option, Predicate } from "effect";
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
  const tags = new Map<string, string>();
  for (const [key, value] of envelope.tags) {
    const transformed = transformSignalFields(policy, "defect", { [key]: value });
    const kept = transformed.value[key];
    if (Predicate.isString(kept)) tags.set(key, kept);
  }
  const value = {
    ...envelope,
    errorType: envelope.errorType,
    errorMessage: sanitizeText(policy, envelope.errorMessage),
    stack: Option.map(envelope.stack, (stack) => sanitizeText(policy, stack)),
    fingerprint: envelope.fingerprint.map((part) => sanitizeText(policy, part)),
    tags,
    context,
  } satisfies DefectEnvelope;
  return {
    value: Option.some(value),
    redactions: contextDecision.redactions,
    dropped: contextDecision.dropped,
  };
};
