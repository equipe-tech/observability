import { Effect, Layer, Metric, Option, Predicate } from "effect";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import type { EventName } from "../src/contract/EventName.ts";
import type {
  CompiledAuditActionDefinition,
  CompiledEventDefinition,
} from "../src/contract/TelemetryContract.ts";
import {
  AdapterName,
  registerTestingAdapter,
  type ContractRegistry,
} from "../src/profile/ObservabilityAdapter.ts";
import { parseNodeObservabilityConfig } from "../src/profile/ObservabilityConfig.ts";
import { createTestingNodeObservabilityFromConfig } from "../src/node/Observability.ts";
import { TelemetryEventSink } from "../src/contract/EventProducer.ts";

const contract: ContractRegistry = {
  version: 1,
  eventNames: [],
  eventByAlias: new Map<string, CompiledEventDefinition>(),
  eventByName: new Map<EventName, CompiledEventDefinition>(),
  auditActionByAlias: new Map<string, CompiledAuditActionDefinition>(),
  auditActionByName: new Map<string, CompiledAuditActionDefinition>(),
};
const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };
const events = registerTestingAdapter({
  name: AdapterName.make("events"),
  capability: "events",
  stage: "server",
  start: () =>
    Effect.succeed({
      flush: Effect.void,
      close: Effect.void,
      eventLayer: Option.some(
        Layer.succeed(
          TelemetryEventSink,
          TelemetryEventSink.of({ record: () => Effect.void, recordBrowser: () => Effect.void }),
        ),
      ),
      degraded: () => false,
    }),
});

const config = (endpoint: URL) =>
  Effect.runPromise(
    parseNodeObservabilityConfig({
      enabled: true,
      profile: "worker",
      service: { name: "worker-e2e", version: "1.4.0", environment: "test" },
      telemetry: { endpoint },
      evlog: { contract, policy },
      sentry: { enabled: false },
    }),
  );

describe("Node observability boundary", () => {
  it("exports built-in logs, traces, and metrics through one worker runtime", async () => {
    const paths: Array<string> = [];
    const server = createServer((request, response) => {
      if (request.url !== undefined) paths.push(request.url);
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || Predicate.isString(address)) {
      throw new Error("Expected a TCP server address.");
    }
    const parsed = await config(new URL(`http://127.0.0.1:${address.port}`));
    const handle = await createTestingNodeObservabilityFromConfig(parsed, [events]);
    if (!handle.enabled) throw new Error("Expected enabled observability.");
    const counter = Metric.counter("worker.jobs");
    await handle.runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("worker completed");
        yield* Metric.update(counter, 1);
      }).pipe(Effect.withSpan("worker.run")),
    );
    const report = await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(report.durationMillis).toBeLessThanOrEqual(5_000);
    expect(paths.some((path) => path.endsWith("/v1/logs"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/v1/traces"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/v1/metrics"))).toBe(true);
  });

  it("does not block application work when the Collector is unavailable", async () => {
    const parsed = await config(new URL("http://127.0.0.1:1"));
    const handle = await createTestingNodeObservabilityFromConfig(parsed, [events]);
    if (!handle.enabled) throw new Error("Expected enabled observability.");
    let completed = false;
    await handle.runtime.runPromise(
      Effect.sync(() => {
        completed = true;
      }),
    );
    const report = await handle.close();
    expect(completed).toBe(true);
    expect(report.durationMillis).toBeLessThanOrEqual(5_000);
  });
});
