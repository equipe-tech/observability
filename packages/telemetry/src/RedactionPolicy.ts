export { sanitizeBrowserFields, sanitizeEventName } from "./policy/BrowserFieldPolicy.ts";
export {
  baseBlockedKeys,
  baseBlockedValuePatterns,
  collectorBlockedKeyPattern,
  collectorBlockedValuePatterns,
  isSensitiveFieldKey,
  sensitiveFieldReplacement,
  sensitiveTextReplacement,
} from "./policy/PolicyVocabulary.ts";
