import { Effect } from "effect";
import type { AdapterRegistration } from "@equipe-tech/observability";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  type ConformanceEvidenceProvider,
  type ConformanceViolation,
} from "@equipe-tech/observability/testing";
import type { EvlogDropReport } from "../EvlogAdapter.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (message: string, offendingValue: string, cause?: unknown): ConformanceViolation => ({
  message,
  offendingValue,
  cause: cause ?? offendingValue,
});

export const evlogConformance = (input: {
  readonly registration: AdapterRegistration;
  readonly drops: EvlogDropReport;
}): ConformanceProvider<"server-events.evlog-collector"> =>
  defineConformanceEvidenceProvider({
    id: "server-events.evlog-collector",
    owner: "evlog",
    verify: () =>
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
        return {
          owner: "evlog",
          receiptType: "evlog-delivery",
          receiptId: registration.adapter.name,
          summary: "server events exported through the official evlog adapter without drops",
        } as const;
      }),
  });
