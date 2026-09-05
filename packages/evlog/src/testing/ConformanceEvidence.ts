import { Effect } from "effect";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type ConformanceEvidenceProvider,
  telemetryDestinationMatches,
  type TelemetryDestinationReceipt,
} from "@equipe-tech/observability/testing";
import { isEvlogDeliveryReceipt, type EvlogDeliveryReceipt } from "../DeliveryEvidence.ts";
import type { EvlogDropReport } from "../EvlogAdapter.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export const evlogConformance = (input: {
  readonly delivery: EvlogDeliveryReceipt;
  readonly drops: EvlogDropReport;
  readonly destination: TelemetryDestinationReceipt;
  readonly runId: string;
  readonly eventName: string;
}): ConformanceProvider<"server-events.evlog-collector"> =>
  defineConformanceEvidenceProvider({
    id: "server-events.evlog-collector",
    owner: "evlog",
    verify: (target) =>
      Effect.gen(function* () {
        if (
          !isEvlogDeliveryReceipt(input.delivery) ||
          input.delivery.runId !== input.runId ||
          input.delivery.eventName !== input.eventName ||
          input.delivery.serviceName !== target.binding.identity.serviceName ||
          input.delivery.serviceVersion !== target.binding.identity.serviceVersion ||
          input.delivery.environment !== target.binding.identity.environment
        ) {
          return yield* Effect.fail(
            violation(
              "The server event has no sealed receipt from the evlog adapter instance that admitted the current run and contract event.",
              `${input.runId}:${input.eventName}`,
            ),
          );
        }
        if (
          !telemetryDestinationMatches(
            input.destination,
            target.topology,
            input.runId,
            target.binding,
          )
        ) {
          return yield* Effect.fail(
            violation(
              "The evlog event has no Collector or destination read-back bound to its topology, run, and identity.",
              `${input.runId}:${input.eventName}`,
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
        const delivered = input.destination.telemetry.logs.some(
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
