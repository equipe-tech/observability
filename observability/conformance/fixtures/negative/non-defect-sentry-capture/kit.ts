import { Effect, Option } from "effect";
import {
  assertConformanceFailure,
  runConformance,
  type ConformanceCheckId,
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { nestjsDefectBoundaryConformance } from "@equipe-tech/observability-nestjs/testing";
import { buildNestjsConformance, nestjsCatalog } from "../../positive/nestjs-api/kit.ts";

export const runNonDefectSentryCaptureFixture = async (): Promise<ConformanceProfileReport> => {
  const built = await buildNestjsConformance(true);
  const expectedCapture = Option.getOrThrow(built.kit.expectedCaptureOutcome);
  const target: ConformanceTarget = {
    name: "negative-expected-sentry-capture",
    profile: "nestjs-api",
    environment: "test",
    topology: "local",
    capabilities: { traces: true, metrics: true, defects: true, browserIngest: false, audit: true },
    providers: [
      ...built.providers.filter((provider) => provider.id !== "sentry.unexpected-defects-only"),
      nestjsDefectBoundaryConformance({
        boundary: built.kit.boundary,
        correlation: built.kit.correlation,
        errors: [
          { error: nestjsCatalog.APP_NOT_FOUND(), captured: expectedCapture.kind === "queued" },
        ],
      }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};

export const expectNonDefectSentryCaptureFailure = async (): Promise<void> => {
  const report = await runNonDefectSentryCaptureFixture();
  await Effect.runPromise(
    assertConformanceFailure(report, "sentry.unexpected-defects-only" satisfies ConformanceCheckId),
  );
};
