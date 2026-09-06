import { assert, describe, it } from "@effect/vitest";
import {
  defineTelemetryContract,
  telemetryContractDefinition,
  type AttributeValue,
  type EventPayloadOf,
  type EventProducer,
  type TelemetryContractInput,
} from "../src/contract/index.ts";

const typedInput = telemetryContractDefinition({
  version: 1,
  events: {
    Renewal: {
      name: "subscription.renewal",
      kind: "domain",
      defaultSeverity: "info",
      mandatory: false,
      sampling: { kind: "always" },
      attributes: {
        "subscription.plan": {
          classification: "public",
          required: true,
          metricLabel: true,
        },
        "subscription.cycle": {
          classification: "public",
          required: false,
          metricLabel: true,
        },
      },
    },
    Audit: {
      name: "access.reviewed",
      kind: "audit",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
    Defect: {
      name: "browser.error",
      kind: "defect",
      defaultSeverity: "error",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {
        "error.origin": {
          classification: "public",
          required: true,
          metricLabel: true,
        },
      },
    },
  },
  metrics: {},
  auditActions: {
    AccessReviewed: {
      action: "access.reviewed",
      resourceType: "account",
      allowedOutcomes: ["success"],
    },
  },
});

const dynamicName: string = "runtime.event";
const dynamicInput = {
  version: 1,
  events: {
    Dynamic: {
      name: dynamicName,
      kind: "domain",
      defaultSeverity: "info",
      mandatory: false,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {},
  auditActions: {},
} satisfies TelemetryContractInput;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type ProducerAlias = Parameters<EventProducer<typeof typedInput>["emit"]>[0];
type RenewalPayload = EventPayloadOf<typeof typedInput, "Renewal">;
type RenewalAttributes = RenewalPayload["attributes"];
type DefectPayload = EventPayloadOf<typeof typedInput, "Defect">;
type AuditPayload = EventPayloadOf<typeof typedInput, "Audit">;
type DynamicContractArgument = Parameters<typeof defineTelemetryContract<typeof dynamicInput>>[0];

const producerTypeAssertions = [
  true satisfies Assert<Equal<Extract<"Missing", ProducerAlias>, never>>,
  true satisfies Assert<Equal<keyof RenewalAttributes, "subscription.plan" | "subscription.cycle">>,
  true satisfies Assert<
    Equal<Pick<RenewalAttributes, never> extends RenewalAttributes ? true : false, false>
  >,
  true satisfies Assert<Equal<Extract<DefectPayload, { readonly outcome: "success" }>, never>>,
  true satisfies Assert<
    Equal<typeof dynamicInput extends DynamicContractArgument ? true : false, false>
  >,
  true satisfies Assert<Equal<Extract<{ readonly nested: true }, AttributeValue>, never>>,
  true satisfies Assert<Equal<AuditPayload["outcome"], "success">>,
  true satisfies Assert<Equal<AuditPayload["audit"]["action"], "access.reviewed">>,
  true satisfies Assert<Equal<AuditPayload["audit"]["resourceType"], "account">>,
];

describe("contract producer types", () => {
  it("rejects aliases, attributes, missing fields, defect outcomes and dynamic names", () => {
    assert.isTrue(producerTypeAssertions.every(Boolean));
  });
});
