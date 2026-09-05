import { Predicate } from "effect";
import { maxFieldKeyLength } from "../BrowserEvents.ts";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { AttributeValue, EventAttributes } from "../contract/TelemetryEvent.ts";
import {
  maxOriginalStringLength,
  replaceStructuredText,
  sanitizeBrowserFields,
} from "./BrowserFieldPolicy.ts";
import type { DataPolicy, PolicySurface } from "./DataPolicy.ts";
import {
  replaceEmailCandidates,
  sensitiveFieldReplacement,
  sensitiveTextReplacement,
} from "./PolicyVocabulary.ts";

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
  audit: { maximumFields: 64, maximumTextLength: 4_096 },
  event: { maximumFields: 128, maximumTextLength: 16_384 },
  log: { maximumFields: 128, maximumTextLength: 32_768 },
  span: { maximumFields: 128, maximumTextLength: 32_768 },
  defect: { maximumFields: 128, maximumTextLength: 65_536 },
  resource: { maximumFields: 128, maximumTextLength: 8_192 },
};

const reservedPrefixes = ["event.", "browser."];

const replaceBlockedValues = (policy: DataPolicy, value: string): string => {
  let output = value;
  for (const pattern of policy.blockedValuePatterns) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, sensitiveTextReplacement);
  }
  return replaceStructuredText(replaceEmailCandidates(output));
};

const sanitizeBoundedText = (
  policy: DataPolicy,
  surface: Exclude<PolicySurface, "browser-ingest" | "metric">,
  value: string,
): { readonly value: string; readonly blocked: boolean; readonly truncated: boolean } => {
  const maximum = serverBounds[surface].maximumTextLength;
  const bounded = value.slice(0, maximum);
  const sanitized = replaceBlockedValues(policy, bounded);
  return {
    value: sanitized.slice(0, maximum),
    blocked: sanitized !== bounded,
    truncated: value.length > maximum || sanitized.length > maximum,
  };
};

const transformBrowserFields = (
  policy: DataPolicy,
  fields: EventAttributes,
): PolicyDecision<EventAttributes> => {
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
      const bounded = value.slice(0, maxOriginalStringLength);
      const sanitized = replaceBlockedValues(policy, bounded);
      admitted[key] = value.length > maxOriginalStringLength ? sensitiveTextReplacement : sanitized;
      if (sanitized !== bounded) {
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
  fields: EventAttributes,
): PolicyDecision<EventAttributes> => {
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
