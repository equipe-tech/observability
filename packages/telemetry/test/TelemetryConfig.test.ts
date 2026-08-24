import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { telemetryConfigFromEnv } from "../src/TelemetryConfig.ts";

const validEnvironment = {
  OTEL_SERVICE_NAME: "checkout-api",
  OTEL_SERVICE_VERSION: "1.2.3",
  OTEL_DEPLOYMENT_ENVIRONMENT: "production",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318/otlp",
};

describe("telemetryConfigFromEnv", () => {
  it.effect("decodes a fully specified environment", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv(validEnvironment);
      assert.strictEqual(config.serviceName, "checkout-api");
      assert.strictEqual(config.serviceVersion, "1.2.3");
      assert.strictEqual(config.environment, "production");
      assert.strictEqual(config.otlpEndpoint.toString(), "https://collector.example.com:4318/otlp");
    }),
  );

  it.effect("applies defaults when only the service name is set", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv({
        OTEL_SERVICE_NAME: "checkout-api",
      });
      assert.strictEqual(config.serviceVersion, "0.0.0");
      assert.strictEqual(config.environment, "development");
      assert.strictEqual(config.otlpEndpoint.toString(), "http://localhost:4318/");
    }),
  );

  it.effect("accepts an HTTP OTLP endpoint", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv({
        ...validEnvironment,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      });
      assert.strictEqual(config.otlpEndpoint.toString(), "http://collector:4318/");
    }),
  );

  it.effect("rejects a missing service name", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(telemetryConfigFromEnv({}));
      assert.strictEqual(error._tag, "InvalidTelemetryEnvironment");
      assert.strictEqual(error.code, "OBS_TELEMETRY_INVALID_ENVIRONMENT");
      assert.include(error.message, "OTEL_SERVICE_NAME");
    }),
  );

  it.effect("rejects an empty service name", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(telemetryConfigFromEnv({ OTEL_SERVICE_NAME: "" }));
      assert.strictEqual(error._tag, "InvalidTelemetryEnvironment");
    }),
  );

  for (const endpoint of [
    "collector:4318",
    "/v1/traces",
    "not a URL",
    "ftp://collector.example.com",
    "https://user:secret@collector.example.com",
  ]) {
    it.effect(`rejects the unsafe OTLP endpoint ${JSON.stringify(endpoint)}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          telemetryConfigFromEnv({
            ...validEnvironment,
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          }),
        );
        assert.strictEqual(error._tag, "InvalidTelemetryEnvironment");
        assert.notInclude(error.message, endpoint);
      }),
    );
  }
});
