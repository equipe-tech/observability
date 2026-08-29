import { Effect, Schema } from "effect";
import type { AttributeDefinitionsInput } from "../contract/TelemetryContract.ts";
import { baseBlockedKeys, baseBlockedValuePatterns } from "../RedactionPolicy.ts";
import { InvalidObservabilityConfig } from "./ObservabilityConfigError.ts";

export type DataPolicyInput = {
  readonly attributes: AttributeDefinitionsInput;
  readonly blockedKeys: ReadonlyArray<string>;
  readonly blockedValuePatterns: ReadonlyArray<string>;
};

export type DataPolicy = {
  readonly attributes: AttributeDefinitionsInput;
  readonly blockedKeys: ReadonlyArray<string>;
  readonly blockedValuePatterns: ReadonlyArray<RegExp>;
};

const PolicyDocument = Schema.Struct({
  attributes: Schema.Record(
    Schema.String,
    Schema.Struct({
      classification: Schema.Literals(["public", "internal", "sensitive", "forbidden"]),
      required: Schema.Boolean,
      metricLabel: Schema.Boolean,
    }),
  ),
  blockedKeys: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(256),
  ),
  blockedValuePatterns: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(64),
  ),
});

const decodePolicy = Schema.decodeUnknownEffect(PolicyDocument);

const invalidPolicy = (field: "policy" | "policy.blockedValuePatterns", cause: unknown) =>
  new InvalidObservabilityConfig({
    code: "OBS_OBSERVABILITY_CONFIG_INVALID",
    message:
      field === "policy"
        ? "The data policy is invalid. Use bounded blocked keys and value patterns."
        : "A blocked value pattern is invalid. Use a valid regular expression.",
    field,
    rule: field === "policy" ? "a valid DataPolicy declaration" : "valid regular expressions",
    cause,
  });

export const parseDataPolicy = Effect.fn("parseDataPolicy")(function* (
  input: DataPolicyInput,
): Effect.fn.Return<DataPolicy, InvalidObservabilityConfig> {
  const parsed = yield* decodePolicy(input).pipe(
    Effect.mapError((cause) => invalidPolicy("policy", cause)),
  );
  const patterns = baseBlockedValuePatterns.map(
    (pattern) => new RegExp(pattern.source, pattern.flags),
  );
  for (const source of parsed.blockedValuePatterns) {
    const pattern = yield* Effect.try({
      try: () => new RegExp(source),
      catch: (cause) => invalidPolicy("policy.blockedValuePatterns", cause),
    });
    patterns.push(pattern);
  }
  return {
    attributes: parsed.attributes,
    blockedKeys: [...new Set([...baseBlockedKeys, ...parsed.blockedKeys])],
    blockedValuePatterns: patterns,
  };
});
