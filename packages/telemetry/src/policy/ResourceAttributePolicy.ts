import { Effect } from "effect";
import { isValidAttributeName } from "../contract/EventName.ts";
import type { ResourceAttributes } from "../ResourceIdentity.ts";
import type { DataPolicy } from "./DataPolicy.ts";
import { InvalidDataPolicy } from "./DataPolicyError.ts";

export type ResourceAttribute = {
  readonly key: string;
  readonly value: string;
};

export const parseResourceAttributes = Effect.fn("parseResourceAttributes")(function* (
  policy: DataPolicy,
  canonical: ResourceAttributes,
  additions: ReadonlyArray<ResourceAttribute>,
): Effect.fn.Return<ReadonlyMap<string, string>, InvalidDataPolicy> {
  const parsed = new Map<string, string>(Object.entries(canonical));
  for (const attribute of additions) {
    if (
      !isValidAttributeName(attribute.key) ||
      parsed.has(attribute.key) ||
      policy.classify(attribute.key) === "forbidden"
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
    parsed.set(
      attribute.key,
      policy.classify(attribute.key) === "sensitive" ? "****" : attribute.value,
    );
  }
  return parsed;
});
