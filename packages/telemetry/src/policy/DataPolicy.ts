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
  blockedValuePatterns: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(64),
  ),
});
const decodePolicy = Schema.decodeUnknownEffect(PolicyDocument);
const classifications = new Set(["public", "internal", "sensitive", "forbidden"]);
const reservedNames = new Set(["event.name", "event.kind", "event.type", "event.severity"]);

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

const hasUnsafeNestedRepetition = (source: string): boolean => {
  const groups: Array<boolean> = [];
  let inCharacterClass = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === "(") {
      groups.push(false);
      continue;
    }
    const repetition =
      character === "+" ||
      character === "*" ||
      (character === "{" && /\d/.test(source[index + 1] ?? ""));
    if (character === ")") {
      const containsRepetition = groups.pop() ?? false;
      const next = source[index + 1] ?? "";
      const repeatedGroup =
        next === "+" || next === "*" || (next === "{" && /\d/.test(source[index + 2] ?? ""));
      if (containsRepetition && repeatedGroup) return true;
      if (groups.length > 0 && (containsRepetition || repeatedGroup)) {
        groups[groups.length - 1] = true;
      }
      continue;
    }
    if (repetition && groups.length > 0) groups[groups.length - 1] = true;
  }
  return false;
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
    if (hasUnsafeNestedRepetition(source)) {
      issues.push(
        issue(
          unsafeCode,
          "A policy regular expression has nested repetition. Use a bounded linear-time pattern.",
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
          name.slice(0, 128),
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
