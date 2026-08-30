import { Effect, Predicate } from "effect";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { AttributeValue } from "../contract/TelemetryEvent.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import { InvalidDataPolicy } from "./DataPolicyError.ts";

export type ResourceAttribute = {
  readonly key: string;
  readonly value: AttributeValue;
};

export const parseResourceAttributes = Effect.fn("parseResourceAttributes")(function* (
  policy: DataPolicy,
  attributes: ReadonlyArray<ResourceAttribute>,
): Effect.fn.Return<ReadonlyMap<string, AttributeValue>, InvalidDataPolicy> {
  const parsed = new Map<string, AttributeValue>();
  for (const attribute of attributes) {
    if (
      !isValidAttributeName(attribute.key) ||
      parsed.has(attribute.key) ||
      attribute.key === "service.name" ||
      attribute.key === "service.version" ||
      policy.classify(attribute.key, "resource") === "forbidden"
    ) {
      return yield* new InvalidDataPolicy({
        code: "OBS_POLICY_INVALID",
        message:
          "Data policy compilation failed with 1 issue(s). Fix every reported rule and compile again.",
        issues: [
          {
            code: "OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE",
            message: "A resource attribute is invalid, duplicated, reserved, or forbidden.",
            rule: "unique-resource-attribute",
          },
        ],
      });
    }
    const value =
      policy.classify(attribute.key, "resource") === "sensitive" &&
      Predicate.isString(attribute.value)
        ? "****"
        : attribute.value;
    parsed.set(attribute.key, value);
  }
  return parsed;
});
