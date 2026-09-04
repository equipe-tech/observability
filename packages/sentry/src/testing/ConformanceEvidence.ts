import { Effect } from "effect";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type ConformanceEvidenceProvider,
} from "@equipe-tech/observability/testing";
import type {
  SentryCaptureOutcome,
  SentryVerificationReceipt,
} from "../policy/DefectProjection.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export type SentryConformanceCapture = {
  readonly code: string | undefined;
  readonly outcome: SentryCaptureOutcome;
};

export const sentryUnexpectedDefectsConformance = (input: {
  readonly expectedCodes: ReadonlyArray<string>;
  readonly unexpectedCount: number;
  readonly captures: ReadonlyArray<SentryConformanceCapture>;
}): ConformanceProvider<"sentry.unexpected-defects-only"> =>
  defineConformanceEvidenceProvider({
    id: "sentry.unexpected-defects-only",
    owner: "sentry",
    verify: () =>
      Effect.gen(function* () {
        for (const capture of input.captures) {
          if (capture.code !== undefined && input.expectedCodes.includes(capture.code)) {
            return yield* Effect.fail(
              violation(
                `Expected error ${capture.code} reached Sentry. Only unexpected defects are captured; keep catalog errors inside the application error boundary.`,
                `expected error ${capture.code} reached Sentry`,
              ),
            );
          }
        }
        const captured = input.captures.length;
        if (captured < input.unexpectedCount) {
          return yield* Effect.fail(
            violation(
              `${input.unexpectedCount} unexpected defects were classified but only ${captured} reached Sentry. Wire the defect service at every unexpected boundary.`,
              `${input.unexpectedCount - captured} uncaptured defects`,
            ),
          );
        }
        return {
          owner: "sentry",
          receiptType: "sentry-captures",
          receiptId: `${captured}`,
          summary: `Sentry received only unexpected defects (${captured} of ${input.unexpectedCount})`,
        } as const;
      }),
  });

export const sentryCanaryConformance = (input: {
  readonly verification: SentryVerificationReceipt | SentryCaptureOutcome;
}): ConformanceProvider<"canary.sentry"> =>
  defineConformanceEvidenceProvider({
    id: "canary.sentry",
    owner: "sentry",
    verify: () =>
      Effect.gen(function* () {
        const verification = input.verification;
        if ("flushed" in verification) {
          return {
            owner: "sentry",
            receiptType: "sentry-verification",
            receiptId: verification.eventId,
            summary: "Sentry verification defect settled with HTTP 2xx inside the deadline",
          } as const;
        }
        return yield* Effect.fail(
          violation(
            "The Sentry canary did not confirm delivery. sendVerificationDefect must return a flushed receipt for the verification defect.",
            `Sentry canary outcome ${JSON.stringify(verification)}`,
          ),
        );
      }),
  });
