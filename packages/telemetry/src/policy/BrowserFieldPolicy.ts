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

export {
  baseBlockedKeys,
  baseBlockedValuePatterns,
  collectorBlockedKeyPattern,
  collectorBlockedValuePatterns,
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
  /([A-Za-z0-9_.-]+)(\s*[=:]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^,;\s]+))/g;

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

const replaceStructuredAssignments = (value: string): string => {
  structuredAssignmentPattern.lastIndex = 0;
  let sanitized = "";
  let offset = 0;
  for (const match of value.matchAll(structuredAssignmentPattern)) {
    const index = match.index;
    const full = match[0];
    const key = match[1];
    const separator = match[2];
    if (!Predicate.isNumber(index) || !Predicate.isString(full) || !Predicate.isString(key)) {
      continue;
    }
    sanitized += value.slice(offset, index);
    if (!isSensitiveFieldKey(key) || !Predicate.isString(separator)) {
      sanitized += full;
      offset = index + full.length;
      continue;
    }
    if (Predicate.isString(match[3])) {
      sanitized += `${key}${separator}"${sensitiveTextReplacement}"`;
    } else if (Predicate.isString(match[4])) {
      sanitized += `${key}${separator}'${sensitiveTextReplacement}'`;
    } else {
      sanitized += `${key}${separator}${sensitiveTextReplacement}`;
    }
    offset = index + full.length;
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
      current.assign(replaceCoreValues(replaceStructuredAssignments(current.source)));
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

const sanitizeString = (value: string, outputLimit: number): string => {
  if (value.length > maxOriginalStringLength) {
    return sensitiveTextReplacement;
  }
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = decodeJsonText(value);
    if (Option.isSome(parsed)) {
      const sanitizedJson = Option.getOrElse(
        sanitizeJson(parsed.value),
        () => sensitiveTextReplacement,
      );
      return sanitizedJson.length <= outputLimit ? sanitizedJson : sensitiveTextReplacement;
    }
    if (sensitiveTextTermPattern.test(value)) {
      return sensitiveTextReplacement;
    }
  }
  return replaceCoreValues(replaceStructuredAssignments(value));
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

export const sanitizeBrowserEventName = (name: string): string =>
  sanitizeString(name, maxEventNameLength).slice(0, maxEventNameLength);
