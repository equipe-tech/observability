import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
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
      assert.strictEqual(config.identity.serviceName, "checkout-api");
      assert.strictEqual(config.identity.serviceVersion, "1.2.3");
      assert.strictEqual(config.identity.environment, "production");
      assert.strictEqual(config.otlpEndpoint.toString(), "https://collector.example.com:4318/otlp");
      assert.deepStrictEqual(config.identity.instance, Option.none());
      assert.strictEqual(config.environmentAlias, "omitted");
    }),
  );

  for (const fixture of [
    { name: "an absent value", environment: validEnvironment },
    {
      name: "an explicit undefined value",
      environment: { ...validEnvironment, OTEL_SERVICE_INSTANCE_ID: undefined },
    },
    {
      name: "an empty value",
      environment: { ...validEnvironment, OTEL_SERVICE_INSTANCE_ID: "" },
    },
  ]) {
    it.effect(`treats ${fixture.name} for OTEL_SERVICE_INSTANCE_ID as absent`, () =>
      Effect.gen(function* () {
        const config = yield* telemetryConfigFromEnv(fixture.environment);
        assert.deepStrictEqual(config.identity.instance, Option.none());
      }),
    );
  }

  it.effect("applies defaults when only the service name is set", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv({
        OTEL_SERVICE_NAME: "checkout-api",
      });
      assert.strictEqual(config.identity.serviceVersion, "0.0.0");
      assert.strictEqual(config.identity.environment, "development");
      assert.strictEqual(config.otlpEndpoint.toString(), "http://localhost:4318/");
    }),
  );

  it.effect("decodes the optional service instance", () =>
    Effect.gen(function* () {
      const config = yield* telemetryConfigFromEnv({
        ...validEnvironment,
        OTEL_SERVICE_INSTANCE_ID: "checkout-api-7f9d",
      });
      assert.deepStrictEqual(config.identity.instance, Option.some("checkout-api-7f9d"));
    }),
  );

  for (const fixture of [
    { name: "OTEL_SERVICE_NAME", value: "Checkout_API", field: "service.name" },
    {
      name: "OTEL_DEPLOYMENT_ENVIRONMENT",
      value: "Prod_1",
      field: "deployment.environment.name",
    },
  ] satisfies ReadonlyArray<{
    readonly name: "OTEL_SERVICE_NAME" | "OTEL_DEPLOYMENT_ENVIRONMENT";
    readonly value: string;
    readonly field: string;
  }>) {
    it.effect(`rejects invalid resource identity in ${fixture.name}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          telemetryConfigFromEnv({ ...validEnvironment, [fixture.name]: fixture.value }),
        );
        assert.strictEqual(error._tag, "InvalidResourceIdentity");
        if (error._tag === "InvalidResourceIdentity") {
          assert.strictEqual(error.code, "OBS_RESOURCE_IDENTITY_INVALID");
          assert.strictEqual(error.field, fixture.field);
          assert.strictEqual(error.value, fixture.value);
          assert.notInclude(error.message, validEnvironment.OTEL_EXPORTER_OTLP_ENDPOINT);
        }
      }),
    );
  }

  it.effect("rejects an overlong service instance at the environment boundary", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        telemetryConfigFromEnv({
          ...validEnvironment,
          OTEL_SERVICE_INSTANCE_ID: "a".repeat(129),
        }),
      );
      assert.strictEqual(error._tag, "InvalidResourceIdentity");
      if (error._tag === "InvalidResourceIdentity") {
        assert.strictEqual(error.code, "OBS_RESOURCE_IDENTITY_INVALID");
        assert.strictEqual(error.field, "service.instance.id");
      }
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
