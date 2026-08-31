import { Context, Effect, Schema } from "effect";
import type {
  AttributeClassification,
  AttributeDefinition,
  AttributeDefinitionsInput,
} from "../contract/TelemetryContract.ts";
import { isValidAttributeName } from "../contract/EventName.ts";
import {
  baseBlockedKeyPatternSource,
  baseBlockedValuePatterns,
  isSensitiveFieldKey,
} from "./PolicyVocabulary.ts";
import { InvalidDataPolicy, type PolicyIssue, type PolicyIssueCode } from "./DataPolicyError.ts";

export type PolicySurface =
  | "audit"
  | "event"
  | "log"
  | "span"
  | "metric"
  | "browser-ingest"
  | "defect"
  | "resource";

export type DataPolicyInput = {
  readonly attributes: AttributeDefinitionsInput;
  readonly blockedKeys: ReadonlyArray<string>;
  readonly blockedValuePatterns: ReadonlyArray<string>;
};

export interface DataPolicy {
  readonly attributes: ReadonlyMap<string, AttributeDefinition>;
  readonly blockedKeys: ReadonlyArray<RegExp>;
  readonly blockedValuePatterns: ReadonlyArray<RegExp>;
  readonly classify: (key: string) => AttributeClassification;
}

const AttributeDocument = Schema.Struct({
  classification: Schema.String,
  required: Schema.Boolean,
  metricLabel: Schema.Boolean,
});
const PolicyDocument = Schema.Struct({
  attributes: Schema.Record(Schema.String, AttributeDocument),
  blockedKeys: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(256),
  ),
  blockedValuePatterns: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
});
const decodePolicy = Schema.decodeUnknownEffect(PolicyDocument);
const classifications = new Set(["public", "internal", "sensitive", "forbidden"]);
const reservedNames = new Set(["event.name", "event.kind", "event.type", "event.severity"]);
const maximumRegexRepetition = 64;
const maximumRegexSourceLength = 256;
const maximumRegexFixedWidth = 128;

const issue = (
  code: PolicyIssueCode,
  message: string,
  attributeName?: string,
  rule?: string,
): PolicyIssue => {
  const value: { code: PolicyIssueCode; message: string; attributeName?: string; rule?: string } = {
    code,
    message,
  };
  if (attributeName !== undefined) value.attributeName = attributeName;
  if (rule !== undefined) value.rule = rule;
  return value;
};

const invalid = (issues: ReadonlyArray<PolicyIssue>): InvalidDataPolicy =>
  new InvalidDataPolicy({
    code: "OBS_POLICY_INVALID",
    message: `Data policy compilation failed with ${issues.length} issue(s). Fix every reported rule and compile again.`,
    issues,
  });

const isAcceptedRegex = (source: string): boolean => {
  if (source.length === 0 || source.length > maximumRegexSourceLength) return false;
  let index = 0;
  let canQuantify = false;
  let variableQuantifiers = 0;
  let fixedWidth = 0;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === "^" && index === 0) {
      canQuantify = false;
      index += 1;
      continue;
    }
    if (character === "$" && index === source.length - 1) {
      canQuantify = false;
      index += 1;
      continue;
    }
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) return false;
      canQuantify = true;
      index += 2;
      continue;
    }
    if (character === "[") {
      let classIndex = index + 1;
      if (source[classIndex] === "^") classIndex += 1;
      let classValues = 0;
      let closed = false;
      while (classIndex < source.length) {
        const classCharacter = source[classIndex];
        if (classCharacter === "\\") {
          if (source[classIndex + 1] === undefined) return false;
          classValues += 1;
          classIndex += 2;
          continue;
        }
        if (classCharacter === "]") {
          closed = true;
          classIndex += 1;
          break;
        }
        if (classCharacter === "[") return false;
        classValues += 1;
        classIndex += 1;
      }
      if (!closed || classValues === 0) return false;
      canQuantify = true;
      index = classIndex;
      continue;
    }
    if (character === "?" || character === "+" || character === "*") {
      if (!canQuantify) return false;
      variableQuantifiers += 1;
      if (variableQuantifiers > 1) return false;
      canQuantify = false;
      index += 1;
      continue;
    }
    if (character === "{") {
      if (!canQuantify) return false;
      const quantifier = source.slice(index).match(/^\{\d+(?:,\d*)?\}/);
      if (quantifier === null) return false;
      const repetition = quantifier[0];
      const separator = repetition.indexOf(",");
      const minimum = Number(repetition.slice(1, separator === -1 ? -1 : separator));
      const maximumText = separator === -1 ? undefined : repetition.slice(separator + 1, -1);
      const maximum =
        maximumText === undefined || maximumText === "" ? undefined : Number(maximumText);
      if (
        minimum > maximumRegexRepetition ||
        (maximum !== undefined && maximum > maximumRegexRepetition)
      ) {
        return false;
      }
      if (maximum !== undefined && minimum > maximum) return false;
      if (separator !== -1) {
        variableQuantifiers += 1;
      } else {
        fixedWidth += minimum;
      }
      if (variableQuantifiers > 1 || fixedWidth > maximumRegexFixedWidth) return false;
      canQuantify = false;
      index += repetition.length;
      continue;
    }
    if ("()|.^$}]".includes(character)) return false;
    canQuantify = true;
    index += 1;
  }
  return true;
};

const hasMalformedEscapeOrClass = (source: string): boolean => {
  let escaped = false;
  let inCharacterClass = false;
  for (const character of source) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "[") {
      if (inCharacterClass) return true;
      inCharacterClass = true;
    } else if (character === "]") {
      if (!inCharacterClass) return true;
      inCharacterClass = false;
    }
  }
  return escaped || inCharacterClass;
};

const compilePatterns = (
  sources: ReadonlyArray<string>,
  code: "OBS_POLICY_INVALID_BLOCKED_KEY" | "OBS_POLICY_INVALID_BLOCKED_VALUE_PATTERN",
  unsafeCode: "OBS_POLICY_UNSAFE_BLOCKED_KEY_PATTERN" | "OBS_POLICY_UNSAFE_BLOCKED_VALUE_PATTERN",
  global: boolean,
  issues: Array<PolicyIssue>,
): Array<RegExp> => {
  const patterns: Array<RegExp> = [];
  for (const source of sources) {
    if (!isAcceptedRegex(source)) {
      const malformed = hasMalformedEscapeOrClass(source);
      issues.push(
        issue(
          malformed ? code : unsafeCode,
          malformed
            ? "A policy regular expression is malformed. Use a complete escaped literal or character class."
            : "A policy regular expression uses unsupported syntax. Use literals, escaped literals, character classes, anchors, and direct quantifiers only.",
        ),
      );
      continue;
    }
    try {
      patterns.push(new RegExp(source, global ? "gi" : "i"));
    } catch {
      issues.push(
        issue(
          code,
          code === "OBS_POLICY_INVALID_BLOCKED_KEY"
            ? "A blocked key rule is invalid. Use a bounded regular expression fragment."
            : "A blocked value rule is invalid. Use a bounded regular expression.",
        ),
      );
    }
  }
  return patterns;
};

const rank = (classification: AttributeClassification): number => {
  switch (classification) {
    case "public":
      return 0;
    case "internal":
      return 1;
    case "sensitive":
      return 2;
    case "forbidden":
      return 3;
  }
};

export const definePolicy = <const Policy extends DataPolicyInput>(policy: Policy): Policy =>
  policy;

export const parseDataPolicy = Effect.fn("parseDataPolicy")(function* (
  input: DataPolicyInput,
  contractAttributes: AttributeDefinitionsInput = {},
): Effect.fn.Return<DataPolicy, InvalidDataPolicy> {
  const parsed = yield* decodePolicy(input).pipe(
    Effect.mapError(() =>
      invalid([
        issue(
          "OBS_POLICY_INVALID_DOCUMENT",
          "Data policy document is malformed. Provide attributes, blockedKeys, and blockedValuePatterns.",
        ),
      ]),
    ),
  );
  const issues: Array<PolicyIssue> = [];
  const attributes = new Map<string, AttributeDefinition>();
  if (Object.keys(parsed.attributes).length > 512) {
    issues.push(issue("OBS_POLICY_LIMIT_EXCEEDED", "Data policy exceeds the 512-attribute limit."));
  }
  for (const [name, definition] of Object.entries(parsed.attributes)) {
    if (!isValidAttributeName(name)) {
      issues.push(
        issue(
          "OBS_POLICY_INVALID_ATTRIBUTE_NAME",
          "A policy attribute name is invalid. Use a dotted lowercase name no longer than 128 characters.",
          undefined,
          "dotted-name",
        ),
      );
      continue;
    }
    if (reservedNames.has(name)) {
      issues.push(
        issue(
          "OBS_POLICY_RESERVED_ATTRIBUTE_NAME",
          "A policy attribute collides with a canonical signal field. Rename the application attribute.",
          name,
          "reserved-name",
        ),
      );
      continue;
    }
    if (
      !classifications.has(definition.classification) ||
      ((definition.classification === "sensitive" || definition.classification === "forbidden") &&
        (definition.required || definition.metricLabel))
    ) {
      issues.push(
        issue(
          "OBS_POLICY_INVALID_CLASSIFICATION",
          "A policy attribute has an invalid classification or incompatible flags.",
          name,
          "classification",
        ),
      );
      continue;
    }
    const classification = Schema.decodeUnknownSync(
      Schema.Literals(["public", "internal", "sensitive", "forbidden"]),
    )(definition.classification);
    const contractClassification = contractAttributes[name]?.classification;
    if (
      contractClassification !== undefined &&
      rank(classification) < rank(contractClassification)
    ) {
      issues.push(
        issue(
          "OBS_POLICY_CONTRACT_CONFLICT",
          "A policy attribute is less restrictive than its telemetry contract declaration.",
          name,
          "classification",
        ),
      );
      continue;
    }
    attributes.set(name, { ...definition, classification });
  }
  const applicationKeyPatterns = compilePatterns(
    parsed.blockedKeys,
    "OBS_POLICY_INVALID_BLOCKED_KEY",
    "OBS_POLICY_UNSAFE_BLOCKED_KEY_PATTERN",
    false,
    issues,
  );
  const applicationValuePatterns = compilePatterns(
    parsed.blockedValuePatterns,
    "OBS_POLICY_INVALID_BLOCKED_VALUE_PATTERN",
    "OBS_POLICY_UNSAFE_BLOCKED_VALUE_PATTERN",
    true,
    issues,
  );
  if (issues.length > 0) return yield* invalid(issues);
  const blockedKeys = [new RegExp(baseBlockedKeyPatternSource), ...applicationKeyPatterns];
  const blockedValuePatterns = [
    ...baseBlockedValuePatterns.map((pattern) => new RegExp(pattern.source, pattern.flags)),
    ...applicationValuePatterns,
  ];
  return Object.freeze({
    attributes,
    blockedKeys,
    blockedValuePatterns,
    classify: (key: string) => {
      const declared = attributes.get(key)?.classification ?? "internal";
      if (isSensitiveFieldKey(key) || blockedKeys.some((pattern) => pattern.test(key))) {
        return rank(declared) >= rank("sensitive") ? declared : "sensitive";
      }
      return declared;
    },
  });
});

export const baseDataPolicy = Effect.runSync(
  parseDataPolicy({ attributes: {}, blockedKeys: [], blockedValuePatterns: [] }),
);

export const CurrentDataPolicy = Context.Reference<DataPolicy>(
  "@equipe-tech/observability/CurrentDataPolicy",
  { defaultValue: () => baseDataPolicy },
);
