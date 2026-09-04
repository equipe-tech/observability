import { Effect } from "effect";
import { ConformanceAssertionError } from "./ConformanceFailure.ts";
import type {
  ConformanceCheckId,
  ConformanceProfileReport,
  ConformanceReport,
} from "./ConformanceModel.ts";

const assertionError = (
  code: "OBS_CONFORMANCE_NOT_CONFORMANT" | "OBS_CONFORMANCE_NEGATIVE_FIXTURE_PASSED" | "OBS_CONFORMANCE_EXPECTED_FAILURE_ABSENT",
  message: string,
  offendingValue: string,
): ConformanceAssertionError =>
  new ConformanceAssertionError({
    code,
    message,
    offendingValue,
    cause: offendingValue,
  });

const failureNames = (report: ConformanceProfileReport): ReadonlyArray<string> =>
  report.checks
    .filter((check) => check.status === "fail")
    .map((check) => `${check.id} (${check.failure.code}: ${check.failure.offendingValue})`);

export const assertConforms = (
  report: ConformanceProfileReport | ConformanceReport,
): Effect.Effect<void, ConformanceAssertionError> => {
  if (report.conforms) return Effect.void;
  const reports = "profiles" in report ? report.profiles : [report];
  const failures = reports.flatMap(failureNames);
  return Effect.fail(
    assertionError(
      "OBS_CONFORMANCE_NOT_CONFORMANT",
      `The conformance report does not conform. Failing checks: ${failures.join("; ")}.`,
      failures.join(", "),
    ),
  );
};

export const assertConformanceFailure = (
  report: ConformanceProfileReport,
  expected: ConformanceCheckId,
): Effect.Effect<void, ConformanceAssertionError> => {
  if (report.conforms) {
    return Effect.fail(
      assertionError(
        "OBS_CONFORMANCE_NEGATIVE_FIXTURE_PASSED",
        `The negative fixture conformed unexpectedly. The check ${expected} must fail.`,
        expected,
      ),
    );
  }
  const result = report.checks.find((check) => check.id === expected);
  if (result === undefined) {
    return Effect.fail(
      assertionError(
        "OBS_CONFORMANCE_EXPECTED_FAILURE_ABSENT",
        `The conformance report does not contain the check ${expected}.`,
        expected,
      ),
    );
  }
  if (result.status === "pass" || result.status === "not-applicable") {
    return Effect.fail(
      assertionError(
        "OBS_CONFORMANCE_NEGATIVE_FIXTURE_PASSED",
        `The check ${expected} reported ${result.status} where the negative fixture requires a failure.`,
        expected,
      ),
    );
  }
  return Effect.void;
};
