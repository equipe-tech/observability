import { Effect } from "effect";
import type { CorrelationContext } from "@equipe-tech/observability";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type ConformanceEvidenceProvider,
} from "@equipe-tech/observability/testing";
import { NestErrorBoundary } from "../index.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export type NestDefectScenarioEntry = {
  readonly error: Error;
  readonly captured: boolean;
};

export const nestjsDefectBoundaryConformance = (input: {
  readonly boundary: NestErrorBoundary;
  readonly correlation: CorrelationContext;
  readonly errors: ReadonlyArray<NestDefectScenarioEntry>;
}): ConformanceProvider<"sentry.unexpected-defects-only"> =>
  defineConformanceEvidenceProvider({
    id: "sentry.unexpected-defects-only",
    owner: "nestjs",
    verify: () =>
      Effect.gen(function* () {
        const expectedCaptured: Array<string> = [];
        const uncapturedDefects: Array<string> = [];
        for (const entry of input.errors) {
          const classified = input.boundary.classify(entry.error, input.correlation);
          if (classified.kind === "expected" && entry.captured) {
            expectedCaptured.push(classified.response.body.code);
          }
          if (classified.kind === "unexpected" && !entry.captured) {
            uncapturedDefects.push(classified.code);
          }
        }
        if (expectedCaptured.length > 0) {
          const code = expectedCaptured[0] ?? "";
          return yield* Effect.fail(
            violation(
              `Expected error ${code} reached Sentry. The Nest error boundary must stop catalog errors before the defect service.`,
              `expected error ${code} reached Sentry`,
            ),
          );
        }
        if (uncapturedDefects.length > 0) {
          const code = uncapturedDefects[0] ?? "";
          return yield* Effect.fail(
            violation(
              `Unexpected defect ${code} never reached Sentry. Provide SentryDefects to the error boundary for unclassified defects.`,
              `unexpected defect ${code} missing from Sentry`,
            ),
          );
        }
        return {
          owner: "nestjs",
          receiptType: "defect-classification",
          receiptId: `${input.errors.length}`,
          summary: `the Nest boundary classified ${input.errors.length} errors and Sentry received only unexpected defects`,
        } as const;
      }),
  });
