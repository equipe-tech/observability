import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { buildWorkerTarget } from "../../../observability/conformance/fixtures/positive/worker/kit.ts";
import { observabilityProfiles } from "../src/profile/ObservabilityProfile.ts";
import {
  startOtlpCaptureServer,
  telemetryCanaryConformance,
  type CapturedTelemetry,
  type ConformanceTargetContext,
} from "../src/testing/index.ts";
import { assessTelemetryDestination } from "../src/testing/conformance/TelemetryEvidence.ts";

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
          receipt: assessTelemetryDestination({
            topology: "local",
            runId: kit.runId,
            identity: kit.binding.identity,
            observationId: "trace-linkage-unit-readback",
            readback: () => telemetry,
          }),
          metricRunIdAttribute: "fixture.run_id",
        }).verify(target),
      );
    expect((await verify(kit.telemetry))._tag).toBe("Success");
    expect((await verify({ ...kit.telemetry, metrics: [] }))._tag).toBe("Failure");
    expect(
      (
        await verify({
          ...kit.telemetry,
          logs: kit.telemetry.logs.map((log) => ({
            ...log,
            resourceAttributes: new Map(),
          })),
        })
      )._tag,
    ).toBe("Failure");
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
    const log = kit.telemetry.logs.find((entry) => Option.isSome(entry.spanId));
    expect(log).toBeDefined();
    if (log === undefined || Option.isNone(log.spanId)) {
      throw new Error("The worker did not export a log-linked span.");
    }
    const logSpanId = Option.getOrThrow(log.spanId);
    const first = kit.telemetry.spans.find((span) => span.spanId === logSpanId);
    const second = kit.telemetry.spans.find(
      (span) => span.traceId === first?.traceId && span.spanId !== first.spanId,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      throw new Error("The worker did not export two spans in the linked trace.");
    }
    expect(
      (
        await verify({
          ...kit.telemetry,
          spans: [
            { ...first, parentSpanId: Option.some(second.spanId) },
            { ...second, parentSpanId: Option.some(first.spanId) },
          ],
        })
      )._tag,
    ).toBe("Failure");
  });
});
