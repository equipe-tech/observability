import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { buildWorkerTarget } from "../../../observability/conformance/fixtures/positive/worker/kit.ts";
import { observabilityProfiles } from "../src/profile/ObservabilityProfile.ts";
import {
  startOtlpCaptureServer,
  telemetryCanaryConformance,
  telemetryDestinationReceipt,
  type CapturedTelemetry,
  type ConformanceTargetContext,
} from "../src/testing/index.ts";

describe("conformance trace linkage", () => {
  it("requires captured parent-child and log-span links in the same trace", async () => {
    const receiver = await startOtlpCaptureServer();
    const kit = await buildWorkerTarget(receiver);
    const target: ConformanceTargetContext = {
      name: "fixture-worker",
      profile: observabilityProfiles.worker,
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
    const verify = (telemetry: CapturedTelemetry) =>
      Effect.runPromiseExit(
        telemetryCanaryConformance({
          runId: kit.runId,
          receipt: telemetryDestinationReceipt({
            topology: "local",
            runId: kit.runId,
            identity: kit.binding.identity,
            observationId: "trace-linkage-unit-readback",
            telemetry,
          }),
          metricRunIdAttribute: "fixture.run_id",
        }).verify(target),
      );
    expect((await verify(kit.telemetry))._tag).toBe("Success");
    const child = kit.telemetry.spans.find((span) => Option.isSome(span.parentSpanId));
    expect(child).toBeDefined();
    if (child === undefined) throw new Error("The worker did not export a child span.");
    const orphaned = {
      ...kit.telemetry,
      spans: [{ ...child, parentSpanId: Option.some("ffffffffffffffff") }],
    };
    const unlinkedLogs = kit.telemetry.logs.map((log) => ({
      ...log,
      spanId: Option.some("eeeeeeeeeeeeeeee"),
    }));
    expect((await verify(orphaned))._tag).toBe("Failure");
    expect((await verify({ ...kit.telemetry, logs: unlinkedLogs }))._tag).toBe("Failure");
    expect((await verify({ ...orphaned, logs: unlinkedLogs }))._tag).toBe("Failure");
    expect(
      (
        await verify({
          ...kit.telemetry,
          spans: kit.telemetry.spans.map((span) => ({
            ...span,
            parentSpanId: Option.some(span.spanId),
          })),
        })
      )._tag,
    ).toBe("Failure");
  });
});
