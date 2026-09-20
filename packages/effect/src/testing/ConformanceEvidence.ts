import { Effect } from "effect";
import type { CorrelationContext } from "@equipe-tech/observability";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type ConformanceEvidenceProvider,
} from "@equipe-tech/observability/testing";
import { classifyError } from "../ErrorBoundary.ts";
import type { ErrorCatalog } from "../ErrorCatalog.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export type EffectDefectScenarioEntry = {
  readonly error: unknown;
  readonly captured: boolean;
};

export const effectDefectBoundaryConformance = (input: {
  readonly catalog: ErrorCatalog;
  readonly correlation: CorrelationContext;
  readonly errors: ReadonlyArray<EffectDefectScenarioEntry>;
}): ConformanceProvider<"sentry.unexpected-defects-only"> =>
  defineConformanceEvidenceProvider({
    id: "sentry.unexpected-defects-only",
    owner: "effect",
    verify: () =>
      Effect.gen(function* () {
        const expectedCaptured: Array<string> = [];
        const uncapturedDefects: Array<string> = [];
        for (const entry of input.errors) {
          const classified = yield* classifyError(input.catalog, entry.error, input.correlation);
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
              `Expected error ${code} reached Sentry. The Effect error boundary must stop catalog errors before the defect service.`,
              `expected error ${code} reached Sentry`,
            ),
          );
        }
        if (uncapturedDefects.length > 0) {
          const code = uncapturedDefects[0] ?? "";
          return yield* Effect.fail(
            violation(
              `Unexpected defect ${code} never reached Sentry. Provide captureDefect to the error boundary for unclassified defects.`,
              `unexpected defect ${code} missing from Sentry`,
            ),
          );
        }
        return {
          owner: "effect",
          receiptType: "effect-defect-boundary",
          receiptId: input.catalog.prefix,
          summary: `Effect error boundary classified ${input.errors.length} scenarios with catalog ${input.catalog.prefix}`,
        } as const;
      }),
  });
