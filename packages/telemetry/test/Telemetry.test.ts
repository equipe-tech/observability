import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { parseResourceIdentity } from "../src/ResourceIdentity.ts";
import { layer } from "../src/Telemetry.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import * as Testing from "../src/testing/index.ts";

const unavailableCollector = new TelemetryConfig({
  identity: Effect.runSync(
    parseResourceIdentity({
      serviceName: "telemetry-test",
      serviceVersion: "0.1.0",
      environment: "test",
    }),
  ),
  otlpEndpoint: new URL("http://127.0.0.1:1"),
});

describe("Telemetry.layer", () => {
  it.live("ignores hostile ambient resource identity and optional canonical keys", () =>
    Effect.gen(function* () {
      const previous = process.env["OTEL_RESOURCE_ATTRIBUTES"];
      process.env["OTEL_RESOURCE_ATTRIBUTES"] = [
        "service.namespace=hostile",
        "service.name=hostile",
        "service.version=999.0.0",
        "deployment.environment.name=hostile",
        "deployment.environment=hostile",
        "service.instance.id=hostile",
        "ambient.allowed=present",
      ].join(",");
      const identity = yield* parseResourceIdentity({
        serviceName: "canonical-service",
        serviceVersion: "1.2.3",
        environment: "production",
      });
      const config = new TelemetryConfig({
        identity,
        otlpEndpoint: new URL("http://telemetry.invalid"),
      });
      const result = yield* Testing.run(
        Effect.logInfo("hostile-resource-probe").pipe(Effect.withSpan("hostile.resource")),
        { config },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env["OTEL_RESOURCE_ATTRIBUTES"];
            } else {
              process.env["OTEL_RESOURCE_ATTRIBUTES"] = previous;
            }
          }),
        ),
      );
      assert.isTrue(Exit.isSuccess(result.exit));
      const span = result.telemetry.spans.find(
        (candidate) => candidate.name === "hostile.resource",
      );
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "hostile-resource-probe"),
      );
      assert.isDefined(span);
      assert.isDefined(log);
      for (const resource of [span.resourceAttributes, log.resourceAttributes]) {
        assert.strictEqual(resource.get("service.namespace"), "equipe-tech");
        assert.strictEqual(resource.get("service.name"), "canonical-service");
        assert.strictEqual(resource.get("service.version"), "1.2.3");
        assert.strictEqual(resource.get("deployment.environment.name"), "production");
        assert.isFalse(resource.has("deployment.environment"));
        assert.isFalse(resource.has("service.instance.id"));
        assert.isFalse(resource.has("ambient.allowed"));
      }
    }),
  );

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
