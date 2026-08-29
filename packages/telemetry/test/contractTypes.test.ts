import { assert, describe, it } from "@effect/vitest";
import {
  defineTelemetryContract,
  makeEventProducer,
  type TelemetryContract,
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

const assertProducerTypes = (typedContract: TelemetryContract<typeof typedInput>): void => {
  const producer = makeEventProducer(typedContract);
  // @ts-expect-error unknown aliases are rejected
  producer.emit("Missing", { outcome: "success", attributes: {} });
  producer.emit("Renewal", {
    outcome: "success",
    // @ts-expect-error undeclared attributes are rejected
    attributes: { "subscription.plan": "team", "subscription.tier": "pro" },
  });
  // @ts-expect-error required attributes cannot be omitted
  producer.emit("Renewal", { outcome: "success", attributes: {} });
  producer.emit("Defect", {
    // @ts-expect-error defect outcomes are fixed to failure by the producer
    outcome: "success",
    error: { type: "TypeError", message: "failed", retryable: false },
    attributes: { "error.origin": "browser" },
  });
  const dynamicName: string = "runtime.event";
  defineTelemetryContract({
    version: 1,
    events: {
      // @ts-expect-error runtime-assembled names cannot define a typed contract
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
  });
};

describe("contract producer types", () => {
  it("rejects aliases, attributes, missing fields, defect outcomes and dynamic names", () => {
    assert.isFunction(assertProducerTypes);
  });
});
