import { Schema } from "effect";

export const PolicyIssueCode = Schema.Literals([
  "OBS_POLICY_INVALID_DOCUMENT",
  "OBS_POLICY_INVALID_ATTRIBUTE_NAME",
  "OBS_POLICY_RESERVED_ATTRIBUTE_NAME",
  "OBS_POLICY_INVALID_CLASSIFICATION",
  "OBS_POLICY_INVALID_BLOCKED_KEY",
  "OBS_POLICY_INVALID_BLOCKED_VALUE_PATTERN",
  "OBS_POLICY_UNSAFE_BLOCKED_KEY_PATTERN",
  "OBS_POLICY_UNSAFE_BLOCKED_VALUE_PATTERN",
  "OBS_POLICY_CONTRACT_CONFLICT",
  "OBS_POLICY_LIMIT_EXCEEDED",
  "OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE",
]);
export type PolicyIssueCode = typeof PolicyIssueCode.Type;

export type PolicyIssue = {
  readonly code: PolicyIssueCode;
  readonly message: string;
  readonly attributeName?: string;
  readonly rule?: string;
};

export class InvalidDataPolicy extends Schema.TaggedError<InvalidDataPolicy>()(
  "InvalidDataPolicy",
  {
    code: Schema.Literal("OBS_POLICY_INVALID"),
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        code: PolicyIssueCode,
        message: Schema.String,
        attributeName: Schema.String.pipe(Schema.optionalKey),
        rule: Schema.String.pipe(Schema.optionalKey),
      }),
    ),
  },
) {}
