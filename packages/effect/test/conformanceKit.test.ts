import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { observabilityProfiles } from "@equipe-tech/observability";
import * as Testing from "@equipe-tech/observability/testing";
import {
  buildEffectApiKit,
  effectApiContractInput,
  effectApiPolicy,
} from "../../../observability/conformance/fixtures/positive/effect-api/kit.ts";

describe("effect-api conformance kit", () => {
  it.live(
    "produces lifecycle, producer, and correlation evidence through a real HTTP request",
    () =>
      Effect.gen(function* () {
        const collector = yield* Effect.promise(() => Testing.startOtlpCaptureServer());
        const kit = yield* Effect.promise(() => buildEffectApiKit(collector));
        const target: Testing.ConformanceTargetContext = {
          name: "fixture-effect-api",
          profile: observabilityProfiles["effect-api"],
          environment: "test",
          topology: "local",
          capabilities: {
            traces: true,
            metrics: true,
            defects: false,
            browserIngest: false,
            audit: false,
          },
          binding: kit.binding,
        };
        const providers = [
          Testing.profileConformance({
            profile: "effect-api",
            service: { name: "fixture-effect-api", version: "1.4.0", environment: "test" },
          }),
          Testing.identityConformance({ identity: kit.identity }),
          Testing.contractConformance({ contract: effectApiContractInput }),
          Testing.producersConformance({ receipt: kit.emitReceipt }),
          Testing.correlationConformance({ correlation: kit.correlation }),
          Testing.policyConformance({ policy: effectApiPolicy }),
          Testing.lifecycleConformance({ report: kit.lifecycleReport }),
        ];
        for (const provider of providers) {
          const evidence = yield* provider.verify(target);
          assert.isString(evidence.summary);
        }
        assert.isFalse(kit.lifecycleReport.degraded);
        const serverSpan = kit.telemetry.spans.find((span) => span.name === "GET /items/:id");
        assert.isDefined(serverSpan);
        const child = kit.telemetry.spans.find((span) => span.name === "fixture.item.read");
        assert.isDefined(child);
        assert.deepEqual(child.parentSpanId._tag, "Some");
        const event = kit.telemetry.logs.find(
          (log) => log.attributes.get("event.name") === "item.read",
        );
        assert.isDefined(event);
        assert.equal(event.attributes.get("run.id"), kit.runId);
        assert.isTrue(kit.telemetry.metrics.some((metric) => metric.name === "item.reads"));
      }),
  );
});
