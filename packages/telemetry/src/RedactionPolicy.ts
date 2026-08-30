export {
  sanitizeBrowserFields,
  sanitizeEventName,
  sanitizeEventName as sanitizeBrowserEventName,
} from "./policy/BrowserFieldPolicy.ts";
export {
  baseBlockedKeys,
  baseBlockedValuePatterns,
  collectorBlockedKeyPattern,
  collectorBlockedValuePatterns,
  isSensitiveFieldKey,
  sensitiveFieldReplacement,
  sensitiveTextReplacement,
} from "./policy/PolicyVocabulary.ts";
