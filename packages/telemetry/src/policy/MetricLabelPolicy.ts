import { Predicate } from "effect";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { MetricAttributeValue } from "../Metrics.ts";
import { replaceStructuredAssignments } from "./BrowserFieldPolicy.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import { isSensitiveFieldKey, replaceEmailCandidates } from "./PolicyVocabulary.ts";

const maximumMetricLabelTextLength = 64;
const labelValuePattern = /^[A-Za-z0-9/][A-Za-z0-9._:/-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tracePattern = /^[0-9a-f]{32}$/;
const spanPattern = /^[0-9a-f]{16}$/;
const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const numericIdentifierPattern = /^\d{7,}$/;
const reserved = new Set([
  "service.instance.id",
  "trace.id",
  "span.id",
  "user.id",
  "session.id",
  "unit",
  "time_unit",
]);

export type MetricLabelRejection =
  | "attribute-name"
  | "classification"
  | "identifier-shape"
  | "string-bound"
  | "blocked-value";

export const metricLabelRejection = (
  policy: DataPolicy,
  key: string,
  value: MetricAttributeValue,
): MetricLabelRejection | undefined => {
  if (!isValidAttributeName(key) || reserved.has(key) || isSensitiveFieldKey(key)) {
    return "attribute-name";
  }
  const definition = policy.attributes.get(key);
  const classification = policy.classify(key);
  if (
    definition !== undefined &&
    (!definition.metricLabel ||
      definition.classification === "sensitive" ||
      definition.classification === "forbidden")
  ) {
    return "classification";
  }
  if (classification === "sensitive" || classification === "forbidden") {
    return "classification";
  }
  if (Predicate.isNumber(value)) {
    return Number.isInteger(value) && numericIdentifierPattern.test(String(Math.abs(value)))
      ? "identifier-shape"
      : undefined;
  }
  if (Predicate.isBoolean(value)) return undefined;
  if (value.length > maximumMetricLabelTextLength) return "string-bound";
  if (replaceEmailCandidates(value) !== value) return "blocked-value";
  for (const pattern of policy.blockedValuePatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return "blocked-value";
  }
  if (replaceStructuredAssignments(value) !== value) return "blocked-value";
  if (!labelValuePattern.test(value)) return "string-bound";
  if (
    uuidPattern.test(value) ||
    tracePattern.test(value) ||
    spanPattern.test(value) ||
    ulidPattern.test(value) ||
    numericIdentifierPattern.test(value)
  ) {
    return "identifier-shape";
  }
  return undefined;
};
