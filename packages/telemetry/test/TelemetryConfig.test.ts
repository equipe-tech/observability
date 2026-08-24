import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { telemetryConfigFromEnv } from "../src/TelemetryConfig.ts";

describe("telemetryConfigFromEnv", () => {
  it.effect("decodes a fully specified environment", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv({
        OTEL_SERVICE_NAME: "checkout-api",
        OTEL_SERVICE_VERSION: "1.2.3",
        OTEL_DEPLOYMENT_ENVIRONMENT: "production",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      });
      assert.strictEqual(config.serviceName, "checkout-api");
      assert.strictEqual(config.serviceVersion, "1.2.3");
      assert.strictEqual(config.environment, "production");
      assert.strictEqual(config.otlpEndpoint, "http://collector:4318");
    }),
  );

  it.effect("applies defaults when only the service name is set", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv({
        OTEL_SERVICE_NAME: "checkout-api",
      });
      assert.strictEqual(config.serviceVersion, "0.0.0");
      assert.strictEqual(config.environment, "development");
      assert.strictEqual(config.otlpEndpoint, "http://localhost:4318");
    }),
  );

  it.effect("fails with InvalidTelemetryEnvironment when the service name is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(telemetryConfigFromEnv({}));
      assert.isTrue(Exit.isFailure(exit));
      const error = yield* Effect.flip(telemetryConfigFromEnv({}));
      assert.strictEqual(error._tag, "InvalidTelemetryEnvironment");
      assert.include(error.message, "OTEL_SERVICE_NAME");
    }),
  );

  it.effect("fails with InvalidTelemetryEnvironment on empty service name", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(telemetryConfigFromEnv({ OTEL_SERVICE_NAME: "" }));
      assert.strictEqual(error._tag, "InvalidTelemetryEnvironment");
    }),
  );
});
