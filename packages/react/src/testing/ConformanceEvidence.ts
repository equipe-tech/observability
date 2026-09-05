import { Effect } from "effect";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type ConformanceEvidenceProvider,
} from "@equipe-tech/observability/testing";
import type { BrowserDeliveryCanaryReceipt, BrowserLifecycleReport } from "../index.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export const browserLifecycleConformance = (input: {
  readonly report: BrowserLifecycleReport;
  readonly service: { readonly name: string; readonly environment: string };
}): ConformanceProvider<"lifecycle.profile-compliant"> =>
  defineConformanceEvidenceProvider({
    id: "lifecycle.profile-compliant",
    owner: "react",
    verify: () =>
      Effect.gen(function* () {
        if (input.report.degraded) {
          return yield* Effect.fail(
            violation(
              "The browser lifecycle report is degraded. Dispose the browser runtime inside the react-web shutdown deadline.",
              "degraded browser lifecycle report",
            ),
          );
        }
        return {
          owner: "react",
          receiptType: "browser-lifecycle-report",
          receiptId: `${input.service.name}@${input.service.environment}`,
          summary: `browser runtime disposed in ${input.report.durationMillis}ms without degradation`,
        } as const;
      }),
  });

export const unsupportedBrowserSignalsConformance =
  (): ConformanceProvider<"canary.telemetry-destination"> =>
    defineConformanceEvidenceProvider({
      id: "canary.telemetry-destination",
      owner: "react",
      verify: (target) =>
        Effect.fail(
          violation(
            "The selected React traces or metrics have no owner-verified destination delivery. Install a React runtime that exports every selected signal before claiming conformance.",
            [
              target.capabilities.traces ? "traces" : undefined,
              target.capabilities.metrics ? "metrics" : undefined,
            ]
              .filter((signal) => signal !== undefined)
              .join(","),
          ),
        ),
    });

export const browserRouteCanaryConformance = (input: {
  readonly receipt?: BrowserDeliveryCanaryReceipt | undefined;
  readonly failure?: { readonly message: string; readonly cause?: unknown } | undefined;
}): ConformanceProvider<"canary.browser-route"> =>
  defineConformanceEvidenceProvider({
    id: "canary.browser-route",
    owner: "react",
    verify: () =>
      Effect.gen(function* () {
        if (input.receipt === undefined) {
          return yield* Effect.fail(
            violation(
              input.failure?.message ??
                "The browser delivery canary did not produce an HTTP 202 receipt.",
              input.failure?.message ?? "missing browser delivery canary receipt",
              input.failure?.cause,
            ),
          );
        }
        return {
          owner: "react",
          receiptType: "browser-delivery-canary",
          receiptId: input.receipt.endpointOrigin,
          summary: `browser ingest route answered HTTP ${input.receipt.status} in ${input.receipt.durationMillis}ms`,
        } as const;
      }),
  });
