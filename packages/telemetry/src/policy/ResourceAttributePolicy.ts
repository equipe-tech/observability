import { Effect, Predicate } from "effect";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { ResourceAttributes } from "../ResourceIdentity.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import { InvalidDataPolicy } from "./DataPolicyError.ts";
import { transformSignalFields } from "./PolicyTransform.ts";

export type ResourceAttribute = {
  readonly key: string;
  readonly value: string;
};

export const parseResourceAttributes = Effect.fn("parseResourceAttributes")(function* (
  policy: DataPolicy,
  canonical: ResourceAttributes,
  additions: ReadonlyArray<ResourceAttribute>,
): Effect.fn.Return<ReadonlyMap<string, string>, InvalidDataPolicy> {
  const input: { [key: string]: string } = { ...canonical };
  for (const attribute of additions) {
    if (
      !isValidAttributeName(attribute.key) ||
      !Predicate.isString(attribute.value) ||
      Object.hasOwn(input, attribute.key) ||
      policy.classify(attribute.key) === "forbidden"
    ) {
      return yield* new InvalidDataPolicy({
        code: "OBS_POLICY_INVALID",
        message:
          "Data policy compilation failed with 1 issue(s). Fix every reported rule and compile again.",
        issues: [
          {
            code: "OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE",
            message:
              "A resource attribute is invalid, duplicated, reserved, forbidden, or non-scalar.",
            rule: "unique-resource-attribute",
          },
        ],
      });
    }
    input[attribute.key] = attribute.value;
  }
  const decision = transformSignalFields(policy, "resource", input);
  const parsed = new Map<string, string>();
  for (const [key, value] of Object.entries(decision.value)) {
    if (Predicate.isString(value)) parsed.set(key, value);
  }
  return parsed;
});
