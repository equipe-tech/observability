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

export const collectorBlockedKeyPattern = `(?i:${baseBlockedKeys.join("|")})(?:\\]|\\[|\\x22|\\x27|\\x60|[._-]|[A-Z0-9]|$)`;

const collectorWhitespace = "[[:space:]   -   　\\\\x{2028}\\\\x{2029}\\\\x{feff}]";

export const collectorBlockedValuePatterns = [
  `(?i)Bearer${collectorWhitespace}+[A-Za-z0-9._~+/=-]+`,
  "(?:sk|rk)[_-][A-Za-z0-9_*.-]{3,}",
  "eyJ[A-Za-z0-9_-]+[.]eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+",
  "(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}",
  "(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
];

export const baseBlockedValuePatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:sk|rk)[_-][A-Za-z0-9_*.-]{3,}/g,
  /eyJ[A-Za-z0-9_-]+[.]eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const asciiCaseInsensitive = (source: string): string =>
  source.replace(/[A-Za-z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
const sensitiveTerms = baseBlockedKeys.map(asciiCaseInsensitive).join("|");
export const baseBlockedKeyPatternSource = `(?:${sensitiveTerms})(?=[\\]\\["'\x60]|[._-]|[A-Z0-9]|$)`;
const sensitiveKeyPattern = new RegExp(baseBlockedKeyPatternSource);

export const isSensitiveFieldKey = (key: string): boolean => sensitiveKeyPattern.test(key);

const isEmailLocalCharacter = (character: string): boolean => /[A-Za-z0-9._%+-]/.test(character);
const isEmailDomainCharacter = (character: string): boolean => /[A-Za-z0-9.-]/.test(character);
const isAsciiLetter = (character: string): boolean => /[A-Za-z]/.test(character);

export const replaceEmailCandidates = (value: string): string => {
  let output = "";
  let offset = 0;
  let index = 0;
  while (index < value.length) {
    if (!isEmailLocalCharacter(value[index] ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < value.length && isEmailLocalCharacter(value[index] ?? "")) index += 1;
    if (value[index] !== "@") continue;
    index += 1;
    const domainStart = index;
    let lastDot = -1;
    while (index < value.length && isEmailDomainCharacter(value[index] ?? "")) {
      if (value[index] === ".") lastDot = index;
      index += 1;
    }
    let suffixIsLetters = lastDot >= domainStart && index - lastDot >= 3;
    if (suffixIsLetters) {
      for (let suffixIndex = lastDot + 1; suffixIndex < index; suffixIndex += 1) {
        if (!isAsciiLetter(value[suffixIndex] ?? "")) suffixIsLetters = false;
      }
    }
    if (domainStart === index || !suffixIsLetters) continue;
    output += value.slice(offset, start) + sensitiveTextReplacement;
    offset = index;
  }
  return output + value.slice(offset);
};
