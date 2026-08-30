import { Option, Predicate, Schema } from "effect";
import {
  maxEventNameLength,
  maxFieldKeyLength,
  maxFieldsPerEvent,
  maxFieldValueLength,
  type BrowserEventFields,
} from "../BrowserEvents.ts";
import type { WideEventFields } from "../WideEvent.ts";
import {
  baseBlockedKeys,
  baseBlockedValuePatterns,
  isSensitiveFieldKey,
  sensitiveFieldReplacement,
  sensitiveTextReplacement,
} from "./PolicyVocabulary.ts";

const maxOriginalFieldKeyLength = 2_048;
const maxOriginalStringLength = 16_384;
const maxJsonDepth = 32;
const maxJsonValues = 1_024;

const SensitiveScalar = Schema.Union([
  Schema.String,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
]);
const decodeSensitiveScalar = Schema.decodeUnknownOption(SensitiveScalar);
const decodeJsonText = Schema.decodeOption(Schema.fromJsonString(Schema.Json));
const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

type SensitiveScalar = typeof SensitiveScalar.Type;
type SanitizedFieldEntry = readonly [string, SensitiveScalar];
type JsonValue = typeof Schema.Json.Type;
type SanitizedJson = null | string | number | boolean | Array<SanitizedJson> | SanitizedJsonObject;
interface SanitizedJsonObject {
  [key: string]: SanitizedJson;
}
interface JsonTraversal {
  readonly source: JsonValue;
  readonly depth: number;
  readonly sensitive: boolean;
  readonly assign: (value: SanitizedJson) => void;
}

const asciiCaseInsensitive = (source: string): string =>
  source.replace(/[A-Za-z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
const sensitiveTerms = baseBlockedKeys.map(asciiCaseInsensitive).join("|");
const sensitiveTextTermPattern = new RegExp(
  `(?:${sensitiveTerms})(?=[._-]|[A-Z0-9]|[^A-Za-z0-9._-]|$)`,
);

const structuredAssignmentPattern =
  /(?:"([A-Za-z0-9_.\-[\]]+)"|([A-Za-z0-9_.\-[\]]+))(\s*[=:]\s*)/g;

const closingQuoteIndex = (value: string, start: number, quote: string): number => {
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index;
    }
  }
  return -1;
};

const safeValueEnd = (value: string, start: number): number => {
  const ampersand = value.indexOf("&", start);
  const fragment = value.indexOf("#", start);
  if (ampersand === -1) return fragment === -1 ? value.length : fragment;
  if (fragment === -1) return ampersand;
  return Math.min(ampersand, fragment);
};

const replaceCoreValues = (value: string): string => {
  let sanitized = value;
  for (const pattern of baseBlockedValuePatterns) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, sensitiveTextReplacement);
  }
  return sanitized;
};

const containsCoreValue = (value: string): boolean => {
  for (const pattern of baseBlockedValuePatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
};

export const replaceStructuredAssignments = (value: string): string => {
  structuredAssignmentPattern.lastIndex = 0;
  let sanitized = "";
  let offset = 0;
  for (const match of value.matchAll(structuredAssignmentPattern)) {
    const index = match.index;
    const full = match[0];
    const quotedKey = match[1];
    const unquotedKey = match[2];
    const key = Predicate.isString(quotedKey) ? quotedKey : unquotedKey;
    if (
      !Predicate.isNumber(index) ||
      !Predicate.isString(full) ||
      !Predicate.isString(key) ||
      index < offset ||
      !isSensitiveFieldKey(key)
    ) {
      continue;
    }
    const valueStart = index + full.length;
    const explicitQuote = value[valueStart];
    const enclosingQuote = value[index - 1];
    const quote =
      explicitQuote === '"' || explicitQuote === "'"
        ? explicitQuote
        : enclosingQuote === '"' || enclosingQuote === "'"
          ? enclosingQuote
          : undefined;
    const quotedValueStart = quote === explicitQuote ? valueStart + 1 : valueStart;
    const quotedValueEnd =
      quote === undefined ? -1 : closingQuoteIndex(value, quotedValueStart, quote);
    sanitized += value.slice(offset, index) + full;
    if (quotedValueEnd >= 0 && quote !== undefined) {
      if (quote === explicitQuote) sanitized += quote;
      sanitized += sensitiveTextReplacement + quote;
      offset = quotedValueEnd + 1;
      continue;
    }
    sanitized += sensitiveTextReplacement;
    offset = safeValueEnd(value, valueStart);
  }
  return sanitized + value.slice(offset);
};

const containsStructuredAssignment = (value: string): boolean =>
  replaceStructuredAssignments(value) !== value;

const sanitizeJson = (source: JsonValue): Option.Option<string> => {
  const root: { value: SanitizedJson } = { value: null };
  const stack: Array<JsonTraversal> = [
    {
      source,
      depth: 0,
      sensitive: false,
      assign: (value) => {
        root.value = value;
      },
    },
  ];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!Predicate.isNotUndefined(current)) {
      continue;
    }
    visited += 1;
    if (visited > maxJsonValues || current.depth > maxJsonDepth) {
      return Option.none();
    }
    if (current.sensitive) {
      current.assign(sensitiveTextReplacement);
      continue;
    }
    if (
      current.source === null ||
      Predicate.isNumber(current.source) ||
      Predicate.isBoolean(current.source)
    ) {
      current.assign(current.source);
      continue;
    }
    if (Predicate.isString(current.source)) {
      current.assign(replaceStructuredAssignments(replaceCoreValues(current.source)));
      continue;
    }
    if (Array.isArray(current.source)) {
      const output: Array<SanitizedJson> = current.source.map(() => null);
      current.assign(output);
      for (let index = current.source.length - 1; index >= 0; index -= 1) {
        const child = current.source[index];
        if (!Predicate.isNotUndefined(child)) {
          continue;
        }
        stack.push({
          source: child,
          depth: current.depth + 1,
          sensitive: false,
          assign: (value) => {
            output[index] = value;
          },
        });
      }
      continue;
    }
    const sourceObject = decodeJsonObject(current.source);
    if (Option.isNone(sourceObject)) {
      return Option.none();
    }
    const output: SanitizedJsonObject = Object.create(null);
    const outputKeys = new Set<string>();
    current.assign(output);
    const keys = Object.keys(sourceObject.value);
    for (const key of keys) {
      if (
        key.length > maxOriginalFieldKeyLength ||
        containsCoreValue(key) ||
        containsStructuredAssignment(key)
      ) {
        continue;
      }
      output[key] = null;
      outputKeys.add(key);
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (!Predicate.isString(key) || !outputKeys.has(key)) {
        continue;
      }
      const child = sourceObject.value[key];
      if (!Predicate.isNotUndefined(child)) {
        continue;
      }
      stack.push({
        source: child,
        depth: current.depth + 1,
        sensitive: isSensitiveFieldKey(key),
        assign: (value) => {
          output[key] = value;
        },
      });
    }
  }
  return Option.some(JSON.stringify(root.value));
};

export const replaceStructuredText = (value: string): string => {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = decodeJsonText(value);
    if (Option.isSome(parsed)) {
      return Option.getOrElse(sanitizeJson(parsed.value), () => sensitiveTextReplacement);
    }
    if (sensitiveTextTermPattern.test(value)) return sensitiveTextReplacement;
  }
  return replaceStructuredAssignments(value);
};

const sanitizeString = (value: string, outputLimit: number): string => {
  if (value.length > maxOriginalStringLength) {
    return sensitiveTextReplacement;
  }
  const sanitized = replaceStructuredText(replaceCoreValues(value));
  const trimmed = value.trimStart();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && sanitized.length > outputLimit) {
    return sensitiveTextReplacement;
  }
  return sanitized;
};

const shouldDropKey = (key: string): boolean =>
  key.length > maxOriginalFieldKeyLength ||
  containsCoreValue(key) ||
  containsStructuredAssignment(key);

export const sanitizeBrowserFields = (fields: WideEventFields): BrowserEventFields => {
  const sanitized: Array<SanitizedFieldEntry> = [];
  const boundedKeys = new Set<string>();
  for (const [key, runtimeValue] of Object.entries(fields)) {
    const decoded = decodeSensitiveScalar(runtimeValue);
    if (Option.isNone(decoded) || key === "" || shouldDropKey(key)) {
      continue;
    }
    const boundedKey = key.slice(0, maxFieldKeyLength);
    if (boundedKeys.has(boundedKey)) {
      continue;
    }
    const value = isSensitiveFieldKey(key)
      ? sensitiveFieldReplacement
      : Predicate.isString(decoded.value)
        ? sanitizeString(decoded.value, maxFieldValueLength).slice(0, maxFieldValueLength)
        : decoded.value;
    sanitized.push([boundedKey, value]);
    boundedKeys.add(boundedKey);
    if (boundedKeys.size >= maxFieldsPerEvent) {
      break;
    }
  }
  return Object.fromEntries(sanitized);
};

export const sanitizeEventName = (name: string): string =>
  sanitizeString(name, maxEventNameLength).slice(0, maxEventNameLength);
