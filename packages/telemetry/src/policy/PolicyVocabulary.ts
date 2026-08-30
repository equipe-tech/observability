export const sensitiveFieldReplacement = "****";
export const sensitiveTextReplacement = "[REDACTED]";
export const effectDroppedAttributesKey = "effect.dropped_attributes_count";

export const baseBlockedKeys = [
  "authorization",
  "proxy[._-]?authorization",
  "cookie",
  "set[._-]?cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "api[._-]?key",
  "apikey",
  "access[._-]?key",
  "client[._-]?secret",
  "private[._-]?key",
  "email",
  "phone",
  "cpf",
  "cnpj",
  "document",
];

export const collectorBlockedKeyPattern = `(?i:${baseBlockedKeys.join("|")})(?:[._-]|[A-Z0-9]|$)`;

export const collectorBlockedValuePatterns = [
  "(?i)Bearer[[:space:]]+[A-Za-z0-9._~+/=-]+",
  "(?:sk|rk)[_-][A-Za-z0-9_*.-]{3,}",
  "eyJ[A-Za-z0-9_-]+[.]eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+",
  "(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}",
  "(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
];

export const baseBlockedValuePatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:sk|rk)[_-][A-Za-z0-9_*.-]{3,}/g,
  /eyJ[A-Za-z0-9_-]+[.]eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/g,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const asciiCaseInsensitive = (source: string): string =>
  source.replace(/[A-Za-z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
const sensitiveTerms = baseBlockedKeys.map(asciiCaseInsensitive).join("|");
export const baseBlockedKeyPatternSource = `(?:${sensitiveTerms})(?=[._-]|[A-Z0-9]|$)`;
const sensitiveKeyPattern = new RegExp(baseBlockedKeyPatternSource);

export const isSensitiveFieldKey = (key: string): boolean => sensitiveKeyPattern.test(key);
