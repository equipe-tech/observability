import { Effect, Metric } from "effect";
import { Telemetry } from "../../src/index.ts";
import { ingestBrowserEvents } from "../../src/node/index.ts";
import type { TelemetryConfig } from "../../src/TelemetryConfig.ts";
import * as WideEvent from "../../src/WideEvent.ts";

const dnsSafe = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

export const canaryRunId = (): string => {
  const user = dnsSafe(process.env["USER"] ?? "ci");
  const entropy = Math.random().toString(36).slice(2, 10);
  return `test-${user === "" ? "ci" : user}-${Date.now()}-${entropy}`;
};

export const emitCanary = (config: TelemetryConfig, runId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const operationCounter = Metric.counter("canary.operations", {
      attributes: { "canary.run_id": runId },
    });
    yield* Effect.sleep("10 millis").pipe(Effect.withSpan("canary.child"));
    yield* WideEvent.emit("canary.completed", { "canary.run_id": runId });
    yield* ingestBrowserEvents({
      version: 1,
      events: [
        {
          id: `browser-${runId}`,
          name: "canary.browser",
          occurredAt: Date.now(),
          fields: { "canary.run_id": runId },
        },
      ],
    }).pipe(Effect.orDie);
    yield* Metric.update(operationCounter, 1);
  }).pipe(
    Effect.withSpan("canary.operation", {
      attributes: { "canary.run_id": runId },
    }),
    Effect.provide(Telemetry.layer(config)),
  );
