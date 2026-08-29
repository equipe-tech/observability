import { assert, describe, it } from "@effect/vitest";
import {
  defineTelemetryContract,
  type AttributeValue,
  type EventPayloadOf,
  type EventProducer,
  type TelemetryContractInput,
} from "../src/contract/index.ts";

const typedInput = {
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
  auditActions: {},
} satisfies TelemetryContractInput;

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
type DynamicContractArgument = Parameters<typeof defineTelemetryContract<typeof dynamicInput>>[0];

type ProducerTypeAssertions = [
  Assert<Equal<Extract<"Missing", ProducerAlias>, never>>,
  Assert<Equal<keyof RenewalAttributes, "subscription.plan" | "subscription.cycle">>,
  Assert<Equal<Pick<RenewalAttributes, never> extends RenewalAttributes ? true : false, false>>,
  Assert<Equal<Extract<DefectPayload, { readonly outcome: "success" }>, never>>,
  Assert<Equal<typeof dynamicInput extends DynamicContractArgument ? true : false, false>>,
  Assert<Equal<Extract<{ readonly nested: true }, AttributeValue>, never>>,
];

const producerTypeAssertions: ProducerTypeAssertions = [true, true, true, true, true, true];

describe("contract producer types", () => {
  it("rejects aliases, attributes, missing fields, defect outcomes and dynamic names", () => {
    assert.deepStrictEqual(producerTypeAssertions, [true, true, true, true, true, true]);
  });
});
