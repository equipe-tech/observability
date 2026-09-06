import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { runAuditWithoutDurableReceiptFixture } from "../../../observability/conformance/fixtures/negative/audit-without-durable-receipt/kit.ts";
import { runLocalOtlpNegativeFixture } from "../../../observability/conformance/fixtures/negative/application-local-otlp/kit.ts";
import { runNonDefectSentryCaptureFixture } from "../../../observability/conformance/fixtures/negative/non-defect-sentry-capture/kit.ts";
import { runCliFixture } from "../../../observability/conformance/fixtures/positive/cli/kit.ts";
import { runLibraryFixture } from "../../../observability/conformance/fixtures/positive/library/kit.ts";
import { runNestjsFixture } from "../../../observability/conformance/fixtures/positive/nestjs-api/kit.ts";
import { runReactFixture } from "../../../observability/conformance/fixtures/positive/react-web/kit.ts";
import { runWorkerFixture } from "../../../observability/conformance/fixtures/positive/worker/kit.ts";
import {
  assertConformanceFailure,
  assertConforms,
  type ConformanceCheckId,
} from "../src/testing/index.ts";

const assertPassing = async (
  label: string,
  run: () => Promise<Awaited<ReturnType<typeof runWorkerFixture>>>,
) => {
  const report = await run();
  expect(
    report.conforms,
    `${label} failed: ${JSON.stringify(report.checks.filter((check) => check.status === "fail"))}`,
  ).toBe(true);
  await Effect.runPromise(assertConforms(report));
  return report;
};

describe("conformance profile fixtures", () => {
  it("passes the nestjs-api fixture", async () => {
    const report = await assertPassing("nestjs-api", runNestjsFixture);
    expect(report.profile).toBe("nestjs-api");
  }, 60_000);

  it("passes the worker fixture", async () => {
    await assertPassing("worker", runWorkerFixture);
  }, 60_000);

  it("passes the react-web fixture with browser traces and metrics delivered through Nest", async () => {
    const report = await assertPassing("react-web", runReactFixture);
    const destination = report.checks.find((check) => check.id === "canary.telemetry-destination");
    expect(destination?.status).toBe("pass");
    if (destination?.status !== "pass") throw new Error("Expected React destination evidence.");
    expect(destination.evidence.summary).toMatch(/1 events, 2 spans, and [1-9][0-9]* metrics/);
    expect(report.checks.find((check) => check.id === "canary.browser-route")?.status).toBe("pass");
  }, 60_000);

  it("passes the cli fixture", async () => {
    await assertPassing("cli", runCliFixture);
  }, 60_000);

  it("passes the library fixture", async () => {
    const report = await assertPassing("library", runLibraryFixture);
    expect(
      report.checks.filter((check) => check.status === "not-applicable").map((check) => check.id),
    ).toContain("identity.canonical");
    expect(report.checks.find((check) => check.id === "lifecycle.profile-compliant")?.status).toBe(
      "pass",
    );
  });

  it("rejects a negative fixture whose expected check passes", async () => {
    const report = await runWorkerFixture();
    const failure = await Effect.runPromise(
      Effect.flip(assertConformanceFailure(report, "pipeline.no-application-otlp")),
    );
    expect(failure.code).toBe("OBS_CONFORMANCE_NEGATIVE_FIXTURE_PASSED");
  }, 60_000);

  it("rejects an application-local OTLP pipeline", async () => {
    const report = await runLocalOtlpNegativeFixture();
    expect(report.conforms).toBe(false);
    await Effect.runPromise(
      assertConformanceFailure(report, "pipeline.no-application-otlp" satisfies ConformanceCheckId),
    );
    const failed = report.checks.find((check) => check.id === "pipeline.no-application-otlp");
    if (failed?.status !== "fail") throw new Error("Expected the OTLP boundary check to fail.");
    expect(failed.failure.offendingValue).toContain("effect/unstable/observability");
  }, 60_000);

  it("rejects a non-defect Sentry capture", async () => {
    const report = await runNonDefectSentryCaptureFixture();
    expect(report.conforms).toBe(false);
    await Effect.runPromise(
      assertConformanceFailure(
        report,
        "sentry.unexpected-defects-only" satisfies ConformanceCheckId,
      ),
    );
    const failed = report.checks.find((check) => check.id === "sentry.unexpected-defects-only");
    if (failed?.status !== "fail") throw new Error("Expected the Sentry boundary check to fail.");
    expect(failed.failure.offendingValue).toContain("APP_NOT_FOUND");
  }, 60_000);

  it("rejects an audit action without a durable-ledger receipt", async () => {
    const report = await runAuditWithoutDurableReceiptFixture();
    expect(report.conforms).toBe(false);
    await Effect.runPromise(
      assertConformanceFailure(
        report,
        "audit.durable-before-operational" satisfies ConformanceCheckId,
      ),
    );
    const failed = report.checks.find((check) => check.id === "audit.durable-before-operational");
    if (failed?.status !== "fail") throw new Error("Expected the audit durability check to fail.");
    expect(failed.failure.offendingValue).toContain("fixture.updated");
  }, 60_000);
});
