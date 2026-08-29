import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import {
  defineTelemetryContract,
  makeEventProducer,
  telemetryContractDefinition,
} from "../src/contract/index.ts";
import { layerWideEvent } from "../src/WideEventSink.ts";
import * as Testing from "../src/testing/index.ts";

const contractInput = telemetryContractDefinition({
  version: 1,
  events: {
    Exported: {
      name: "contract.exported",
      kind: "domain",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {
        "contract.fixture": {
          classification: "public",
          required: true,
          metricLabel: true,
        },
      },
    },
  },
  metrics: {},
  auditActions: {},
});

const attributeValue = (attributes: Testing.CapturedAttributes, name: string) =>
  Option.getOrUndefined(Testing.attribute(attributes, name));

describe("contract OTLP integration", () => {
  it.live("exports a valid contract event through WideEvent and the in-memory OTLP path", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract(contractInput);
      const producer = makeEventProducer(contract);
      const run = yield* Testing.run(
        producer
          .emit("Exported", {
            outcome: "success",
            attributes: { "contract.fixture": "valid" },
          })
          .pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isSuccess(run.exit));
      const log = run.telemetry.logs.find(
        (candidate) => attributeValue(candidate.attributes, "event.name") === "contract.exported",
      );
      assert.isDefined(log);
      assert.strictEqual(attributeValue(log.attributes, "event.kind"), "wide");
      assert.strictEqual(attributeValue(log.attributes, "event.type"), "domain");
      assert.strictEqual(attributeValue(log.attributes, "event.outcome"), "success");
      assert.strictEqual(attributeValue(log.attributes, "contract.fixture"), "valid");
    }),
  );

  it.live("keeps invalid names, attributes and sampling outside the emitter", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract(contractInput);
      const producer = makeEventProducer(contract);
      const invalidName = yield* Testing.run(
        producer
          // @ts-expect-error runtime rejection protects JavaScript consumers
          .emit("Unknown", { outcome: "success", attributes: {} })
          .pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isFailure(invalidName.exit));
      assert.lengthOf(invalidName.telemetry.logs, 0);

      const invalidAttribute = yield* Testing.run(
        producer
          .emit("Exported", {
            outcome: "success",
            // @ts-expect-error runtime rejection protects JavaScript consumers
            attributes: { "contract.fixture": "valid", "contract.extra": true },
          })
          .pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isFailure(invalidAttribute.exit));
      assert.lengthOf(invalidAttribute.telemetry.logs, 0);

      const invalidSampling = yield* Effect.flip(
        defineTelemetryContract({
          version: 1,
          events: {
            Invalid: {
              name: "sampling.invalid",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "rate", rate: 0 },
              attributes: {},
            },
          },
          metrics: {},
          auditActions: {},
        }),
      );
      assert.include(
        invalidSampling.issues.map((issue) => issue.code),
        "OBS_CONTRACT_INVALID_SAMPLING_RATE",
      );
    }),
  );
});
