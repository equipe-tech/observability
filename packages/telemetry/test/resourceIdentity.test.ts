import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { readFile } from "node:fs/promises";
import {
  EnvironmentAliasPolicy,
  instanceResourceAttributes,
  parseResourceIdentity,
  releaseIdentifier,
  serviceResourceAttributes,
} from "../src/ResourceIdentity.ts";

const packageManifest: unknown = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
  packageManifest,
).version;

const validIdentity = {
  serviceName: "checkout-api",
  serviceVersion: "1.4.0",
  environment: "production",
  instance: Option.some("checkout-api-7f9d"),
};

describe("ResourceIdentity", () => {
  it.effect("projects one canonical identity for instance and service signals", () =>
    Effect.gen(function* () {
      const identity = yield* parseResourceIdentity(validIdentity);
      assert.deepStrictEqual(instanceResourceAttributes(identity, "omitted"), {
        "service.namespace": "equipe-tech",
        "service.name": "checkout-api",
        "service.version": "1.4.0",
        "deployment.environment.name": "production",
        "service.instance.id": "checkout-api-7f9d",
      });
      assert.deepStrictEqual(serviceResourceAttributes(identity, "omitted"), {
        "service.namespace": "equipe-tech",
        "service.name": "checkout-api",
        "service.version": "1.4.0",
        "deployment.environment.name": "production",
      });
      assert.strictEqual(releaseIdentifier(identity), "1.4.0");
    }),
  );

  for (const serviceName of [
    "Checkout_API",
    "checkout_api",
    "-checkout",
    "checkout-",
    "",
    "a".repeat(64),
  ]) {
    it.effect(`rejects invalid service name ${JSON.stringify(serviceName)}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parseResourceIdentity({ ...validIdentity, serviceName }));
        assert.strictEqual(error.code, "OBS_RESOURCE_IDENTITY_INVALID");
        assert.strictEqual(error.field, "service.name");
        assert.strictEqual(error.value, serviceName);
        assert.include(error.message, error.rule);
      }),
    );
  }

  for (const environment of ["Production", "prod_1", "-prod", "prod-", "", "a".repeat(33)]) {
    it.effect(`rejects invalid environment ${JSON.stringify(environment)}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parseResourceIdentity({ ...validIdentity, environment }));
        assert.strictEqual(error.field, "deployment.environment.name");
        assert.strictEqual(error.value, environment);
      }),
    );
  }

  for (const serviceVersion of ["1.4.0", "1.4.0-rc.1", "1.4.0+build.7", "a".repeat(40)]) {
    it.effect(`accepts release ${serviceVersion}`, () =>
      Effect.gen(function* () {
        const identity = yield* parseResourceIdentity({ ...validIdentity, serviceVersion });
        assert.strictEqual(identity.serviceVersion, serviceVersion);
      }),
    );
  }

  for (const serviceVersion of ["v1.4", "latest", "", "abcdef", "G".repeat(40)]) {
    it.effect(`rejects release ${JSON.stringify(serviceVersion)}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          parseResourceIdentity({ ...validIdentity, serviceVersion }),
        );
        assert.strictEqual(error.field, "service.version");
      }),
    );
  }

  it("requires alias removal before package version 0.4.0", () => {
    const [major = Number.POSITIVE_INFINITY, minor = Number.POSITIVE_INFINITY] = packageVersion
      .split(".")
      .map(Number);
    assert.strictEqual(Schema.decodeUnknownSync(EnvironmentAliasPolicy)("emitted"), "emitted");
    assert.isTrue(major === 0 && minor < 4);
  });

  it.effect("emits the environment alias only under the compatibility policy", () =>
    Effect.gen(function* () {
      const identity = yield* parseResourceIdentity(validIdentity);
      assert.strictEqual(
        instanceResourceAttributes(identity, "emitted")["deployment.environment"],
        "production",
      );
      assert.strictEqual(
        serviceResourceAttributes(identity, "emitted")["deployment.environment"],
        "production",
      );
      assert.isFalse("deployment.environment" in instanceResourceAttributes(identity, "omitted"));
      assert.isFalse("deployment.environment" in serviceResourceAttributes(identity, "omitted"));
    }),
  );
});
