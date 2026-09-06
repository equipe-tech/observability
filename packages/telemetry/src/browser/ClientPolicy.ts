import {
  baseBlockedValuePatterns,
  isSensitiveFieldKey,
  replaceEmailCandidates,
  sensitiveFieldReplacement,
  sensitiveTextReplacement,
} from "../policy/PolicyVocabulary.ts";
import {
  maxEventNameLength,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
} from "./BrowserEventLimits.ts";
import type { BrowserTelemetryClientFields } from "./BrowserClient.ts";

const maximumInputLength = 16_384;
const assignmentPattern =
  /(?:authorization|proxy[._-]?authorization|cookie|set[._-]?cookie|password|passwd|secret|token|api[._-]?key|apikey|access[._-]?key|client[._-]?secret|private[._-]?key|email|phone|cpf|cnpj|document)(?:[._-]|[A-Z0-9]|\]|\[|["'`])?\s*[:=]\s*(?:\\?["'`])?[^,;&#}\]]*/gi;

const sanitizeText = (value: string, limit: number): string => {
  if (value.length > maximumInputLength) return sensitiveTextReplacement;
  let sanitized = value;
  for (const pattern of baseBlockedValuePatterns) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, sensitiveTextReplacement);
  }
  sanitized = replaceEmailCandidates(sanitized).replace(assignmentPattern, (assignment) => {
    const separator = Math.max(assignment.indexOf(":"), assignment.indexOf("="));
    return `${assignment.slice(0, separator + 1)}${sensitiveTextReplacement}`;
  });
  return sanitized.slice(0, limit);
};

const sanitizeValue = (value: string | number | boolean): string | number | boolean | undefined => {
  try {
    if (String(value) === value) return sanitizeText(value, maxFieldValueLength);
    if (Number(value) === value && Number.isFinite(value)) return value;
    if (value === true || value === false) return value;
    return undefined;
  } catch {
    return undefined;
  }
};

export const sanitizeClientFields = (
  fields: BrowserTelemetryClientFields,
): BrowserTelemetryClientFields => {
  const entries: Array<readonly [string, string | number | boolean]> = [];
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(fields)) {
    if (key.length === 0 || key.length > 2_048) continue;
    const boundedKey = key.slice(0, maxFieldKeyLength);
    if (keys.has(boundedKey)) continue;
    const sanitized = isSensitiveFieldKey(key) ? sensitiveFieldReplacement : sanitizeValue(value);
    if (sanitized === undefined) continue;
    entries.push([boundedKey, sanitized]);
    keys.add(boundedKey);
    if (keys.size === maxFieldsPerEvent) break;
  }
  return Object.fromEntries(entries);
};

export const sanitizeClientEventName = (name: string): string =>
  sanitizeText(name, maxEventNameLength);
