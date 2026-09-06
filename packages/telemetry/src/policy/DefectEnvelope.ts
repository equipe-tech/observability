import { Option, Schema } from "effect";
import { CorrelationContext } from "../Correlation.ts";
import type { AttributeValue } from "../contract/TelemetryEvent.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import { sanitizeText, transformSignalFields, type PolicyDecision } from "./PolicyTransform.ts";

export const DefectEnvelope = Schema.Struct({
  errorType: Schema.Literal("UnexpectedDefect"),
  errorMessage: Schema.String,
  stack: Schema.Option(Schema.String),
  fingerprint: Schema.Array(Schema.String),
  tags: Schema.ReadonlyMap(Schema.String, Schema.String),
  context: Schema.ReadonlyMap(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ),
  correlation: CorrelationContext,
});
export type DefectEnvelope = typeof DefectEnvelope.Type;

export type UnexpectedDefectInput = {
  readonly error: Error;
  readonly code: string;
  readonly fingerprint?: ReadonlyArray<string>;
  readonly tags?: ReadonlyMap<string, string>;
  readonly context?: ReadonlyMap<string, AttributeValue>;
  readonly correlation?: CorrelationContext;
};

export const unexpectedDefect = (input: UnexpectedDefectInput): DefectEnvelope => ({
  errorType: "UnexpectedDefect",
  errorMessage: input.error.message,
  stack: Option.fromNullishOr(input.error.stack),
  fingerprint: input.fingerprint ?? [input.code, input.error.name],
  tags: input.tags ?? new Map(),
  context: input.context ?? new Map(),
  correlation: input.correlation ?? new CorrelationContext({}),
});

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
