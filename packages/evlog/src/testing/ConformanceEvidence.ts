import { Effect } from "effect";
import type { AdapterRegistration } from "@equipe-tech/observability";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type CapturedTelemetry,
  type ConformanceEvidenceProvider,
} from "@equipe-tech/observability/testing";
import type { EvlogDropReport } from "../EvlogAdapter.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export const evlogConformance = (input: {
  readonly registration: AdapterRegistration;
  readonly drops: EvlogDropReport;
  readonly telemetry: CapturedTelemetry;
  readonly runId: string;
  readonly eventName: string;
}): ConformanceProvider<"server-events.evlog-collector"> =>
  defineConformanceEvidenceProvider({
    id: "server-events.evlog-collector",
    owner: "evlog",
    verify: (target) =>
      Effect.gen(function* () {
        const registration = input.registration;
        if (registration.kind !== "official" || registration.adapter.capability !== "events") {
          return yield* Effect.fail(
            violation(
              "The server event path does not run through an official evlog events registration. Register the official evlog adapter with registerOfficialAdapter.",
              registration.kind,
            ),
          );
        }
        const drops = input.drops;
        if (drops.total > 0) {
          return yield* Effect.fail(
            violation(
              `The evlog event path dropped ${drops.total} events with reasons ${JSON.stringify(drops.reasons)}. Keep the event path inside the buffer limits and away from a closed state.`,
              `${drops.total} dropped events`,
            ),
          );
        }
        const delivered = input.telemetry.logs.some(
          (log) =>
            log.attributes.get("run.id") === input.runId &&
            log.attributes.get("event.name") === input.eventName &&
            log.resourceAttributes.get("service.name") === target.binding.identity.serviceName &&
            log.resourceAttributes.get("service.version") ===
              target.binding.identity.serviceVersion &&
            log.resourceAttributes.get("deployment.environment.name") ===
              target.binding.identity.environment &&
            target.binding.contract.events.some((event) => event.name === input.eventName),
        );
        if (!delivered) {
          return yield* Effect.fail(
            violation(
              "The evlog adapter has no captured delivery for the current run, target identity, and contract event.",
              `${input.runId}:${input.eventName}`,
            ),
          );
        }
        return {
          owner: "evlog",
          receiptType: "evlog-delivery",
          receiptId: input.runId,
          summary: `captured ${input.eventName} from the current run through the official evlog adapter`,
        } as const;
      }),
  });
