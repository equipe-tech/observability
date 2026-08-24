import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { layer } from "../src/Telemetry.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";

const unavailableCollector = new TelemetryConfig({
  serviceName: "telemetry-test",
  serviceVersion: "0.1.0",
  environment: "test",
  otlpEndpoint: new URL("http://127.0.0.1:1"),
});

describe("Telemetry.layer", () => {
  it.live("does not fail the application when the collector is unavailable", () =>
    Effect.gen(function* () {
      let completed = false;
      yield* Effect.sync(() => {
        completed = true;
      }).pipe(
        Effect.withSpan("collector.unavailable"),
        Effect.provide(layer(unavailableCollector)),
      );
      assert.isTrue(completed);
    }).pipe(Effect.timeout("5 seconds")),
  );
});
