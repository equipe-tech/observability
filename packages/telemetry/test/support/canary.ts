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

export const canarySensitiveValues = (runId: string) => {
  const authorization = `Bearer auth-${runId}`;
  const password = `password-${runId}`;
  const token = `sk-${runId}`;
  const email = `${runId}@example.test`;
  return {
    authorization,
    password,
    token,
    email,
    serializedBody: JSON.stringify({ authorization, password, token, email }),
  };
};

export const emitCanary = (config: TelemetryConfig, runId: string): Effect.Effect<void> => {
  const sensitive = canarySensitiveValues(runId);
  const sensitiveAttributes = {
    "canary.run_id": runId,
    authorization: sensitive.authorization,
    password: sensitive.password,
    "safe.message": `token=${sensitive.token} email=${sensitive.email}`,
  };
  return Effect.gen(function* () {
    const operationCounter = Metric.counter("canary.operations", {
      attributes: sensitiveAttributes,
    });
    yield* Effect.sleep("10 millis").pipe(Effect.withSpan("canary.child"));
    yield* WideEvent.emit("canary.completed", { "canary.run_id": runId });
    yield* Effect.logInfo(sensitive.serializedBody).pipe(
      Effect.annotateLogs({
        ...sensitiveAttributes,
        "event.name": "canary.redaction",
        "event.kind": "wide",
      }),
    );
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
    Effect.withSpan("canary.operation", { attributes: sensitiveAttributes }),
    Effect.provide(Telemetry.layer(config)),
  );
};
