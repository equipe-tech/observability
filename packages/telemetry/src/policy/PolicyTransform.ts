import { Predicate } from "effect";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { AttributeValue } from "../contract/TelemetryEvent.ts";
import { sanitizeBrowserFields } from "./BrowserFieldPolicy.ts";
import type { WideEventFields } from "../WideEvent.ts";
import type { DataPolicy, PolicySurface } from "./DataPolicy.ts";
import { sensitiveFieldReplacement, sensitiveTextReplacement } from "./PolicyVocabulary.ts";

export type PolicyAction = "kept" | "masked" | "replaced" | "truncated" | "dropped";
export type PolicyRule =
  | "blocked-key"
  | "blocked-value"
  | "structured-assignment"
  | "classification"
  | "attribute-name"
  | "reserved-name"
  | "bounds"
  | "unsupported-value"
  | "cardinality"
  | "identifier-shape";

export type PolicyRedaction = {
  readonly rule: PolicyRule;
  readonly action: PolicyAction;
  readonly surface: PolicySurface;
};

export type PolicyDecision<A> = {
  readonly value: A;
  readonly redactions: ReadonlyArray<PolicyRedaction>;
  readonly dropped: number;
};

type MutableFields = { [key: string]: AttributeValue };

const reservedPrefixes = ["event.", "browser."];

const customValue = (policy: DataPolicy, value: string): string => {
  let output = value;
  for (const pattern of policy.blockedValuePatterns) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, sensitiveTextReplacement);
  }
  return output;
};

export const transformSignalFields = (
  policy: DataPolicy,
  surface: PolicySurface,
  fields: WideEventFields,
): PolicyDecision<WideEventFields> => {
  const admitted: MutableFields = {};
  const redactions: Array<PolicyRedaction> = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (
      !isValidAttributeName(key) ||
      (surface === "browser-ingest" && reservedPrefixes.some((prefix) => key.startsWith(prefix)))
    ) {
      dropped += 1;
      continue;
    }
    const classification = policy.classify(key, surface);
    if (classification === "forbidden") {
      dropped += 1;
      if (policy.attributes.has(key)) {
        redactions.push({ rule: "classification", action: "dropped", surface });
      }
      continue;
    }
    if (classification === "sensitive") {
      admitted[key] = sensitiveFieldReplacement;
      if (policy.attributes.has(key)) {
        redactions.push({ rule: "classification", action: "masked", surface });
      }
      continue;
    }
    admitted[key] = Predicate.isString(value) ? customValue(policy, value) : value;
  }
  const sanitized = sanitizeBrowserFields(admitted);
  return { value: sanitized, redactions, dropped };
};

export const sanitizeText = (policy: DataPolicy, value: string): string => {
  const result = sanitizeBrowserFields({ "policy.value": value })["policy.value"];
  if (!Predicate.isString(result)) return sensitiveTextReplacement;
  return customValue(policy, result);
};
