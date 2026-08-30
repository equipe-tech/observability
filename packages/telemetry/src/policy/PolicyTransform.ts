import { Predicate } from "effect";
import { maxFieldKeyLength } from "../BrowserEvents.ts";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { AttributeValue } from "../contract/TelemetryEvent.ts";
import { replaceStructuredAssignments, sanitizeBrowserFields } from "./BrowserFieldPolicy.ts";
import type { WideEventFields } from "../WideEvent.ts";
import type { DataPolicy, PolicySurface } from "./DataPolicy.ts";
import { sensitiveFieldReplacement, sensitiveTextReplacement } from "./PolicyVocabulary.ts";

export type PolicyAction = "masked" | "truncated" | "dropped";
export type PolicyRule =
  | "attribute-name"
  | "blocked-key"
  | "blocked-value"
  | "classification"
  | "bounds";

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

type SignalBounds = {
  readonly maximumFields: number;
  readonly maximumTextLength: number;
};

const serverBounds: {
  readonly [surface in Exclude<PolicySurface, "browser-ingest" | "metric">]: SignalBounds;
} = {
  event: { maximumFields: 128, maximumTextLength: 16_384 },
  log: { maximumFields: 128, maximumTextLength: 32_768 },
  span: { maximumFields: 128, maximumTextLength: 32_768 },
  defect: { maximumFields: 128, maximumTextLength: 65_536 },
  resource: { maximumFields: 128, maximumTextLength: 8_192 },
};

const reservedPrefixes = ["event.", "browser."];

const replaceBlockedValues = (policy: DataPolicy, value: string): string => {
  let output = replaceStructuredAssignments(value);
  for (const pattern of policy.blockedValuePatterns) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, sensitiveTextReplacement);
  }
  return output;
};

const sanitizeBoundedText = (
  policy: DataPolicy,
  surface: Exclude<PolicySurface, "browser-ingest" | "metric">,
  value: string,
): { readonly value: string; readonly blocked: boolean; readonly truncated: boolean } => {
  const sanitized = replaceBlockedValues(policy, value);
  const maximum = serverBounds[surface].maximumTextLength;
  return {
    value: sanitized.slice(0, maximum),
    blocked: sanitized !== value,
    truncated: sanitized.length > maximum,
  };
};

const transformBrowserFields = (
  policy: DataPolicy,
  fields: WideEventFields,
): PolicyDecision<WideEventFields> => {
  const admitted: MutableFields = {};
  const redactions: Array<PolicyRedaction> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (
      !isValidAttributeName(key.slice(0, maxFieldKeyLength)) ||
      reservedPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      redactions.push({ rule: "attribute-name", action: "dropped", surface: "browser-ingest" });
      continue;
    }
    const classification = policy.classify(key);
    if (classification === "forbidden") {
      redactions.push({ rule: "classification", action: "dropped", surface: "browser-ingest" });
      continue;
    }
    if (classification === "sensitive") {
      admitted[key] = sensitiveFieldReplacement;
      redactions.push({
        rule: policy.attributes.has(key) ? "classification" : "blocked-key",
        action: "masked",
        surface: "browser-ingest",
      });
      continue;
    }
    if (Predicate.isString(value)) {
      const sanitized = replaceBlockedValues(policy, value);
      admitted[key] = sanitized;
      if (sanitized !== value) {
        redactions.push({ rule: "blocked-value", action: "masked", surface: "browser-ingest" });
      }
    } else {
      admitted[key] = value;
    }
  }
  const value = sanitizeBrowserFields(admitted);
  const dropped = Object.keys(fields).length - Object.keys(value).length;
  const boundedDrops = dropped - redactions.filter((entry) => entry.action === "dropped").length;
  for (let index = 0; index < boundedDrops; index += 1) {
    redactions.push({ rule: "bounds", action: "dropped", surface: "browser-ingest" });
  }
  for (const [key, original] of Object.entries(admitted)) {
    const boundedKey = key.slice(0, maxFieldKeyLength);
    const sanitized = value[boundedKey];
    if (boundedKey !== key && sanitized !== undefined) {
      redactions.push({ rule: "bounds", action: "truncated", surface: "browser-ingest" });
    }
    if (
      Predicate.isString(original) &&
      Predicate.isString(sanitized) &&
      sanitized.length < original.length
    ) {
      redactions.push({ rule: "bounds", action: "truncated", surface: "browser-ingest" });
    }
  }
  return { value, redactions, dropped };
};

export const transformSignalFields = (
  policy: DataPolicy,
  surface: Exclude<PolicySurface, "metric">,
  fields: WideEventFields,
): PolicyDecision<WideEventFields> => {
  if (surface === "browser-ingest") return transformBrowserFields(policy, fields);
  const admitted: MutableFields = {};
  const redactions: Array<PolicyRedaction> = [];
  const maximumFields = serverBounds[surface].maximumFields;
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!isValidAttributeName(key)) {
      dropped += 1;
      redactions.push({ rule: "attribute-name", action: "dropped", surface });
      continue;
    }
    if (Object.keys(admitted).length >= maximumFields) {
      dropped += 1;
      redactions.push({ rule: "bounds", action: "dropped", surface });
      continue;
    }
    const classification = policy.classify(key);
    if (classification === "forbidden") {
      dropped += 1;
      redactions.push({ rule: "classification", action: "dropped", surface });
      continue;
    }
    if (classification === "sensitive") {
      admitted[key] = sensitiveFieldReplacement;
      redactions.push({
        rule:
          policy.attributes.has(key) || value === sensitiveFieldReplacement
            ? "classification"
            : "blocked-key",
        action: "masked",
        surface,
      });
      continue;
    }
    if (!Predicate.isString(value)) {
      admitted[key] = value;
      continue;
    }
    const sanitized = sanitizeBoundedText(policy, surface, value);
    admitted[key] = sanitized.value;
    if (sanitized.blocked) redactions.push({ rule: "blocked-value", action: "masked", surface });
    if (sanitized.truncated) redactions.push({ rule: "bounds", action: "truncated", surface });
  }
  return { value: admitted, redactions, dropped };
};

export const sanitizeText = (
  policy: DataPolicy,
  value: string,
  surface: Exclude<PolicySurface, "browser-ingest" | "metric" | "resource"> = "log",
): string => sanitizeBoundedText(policy, surface, value).value;
