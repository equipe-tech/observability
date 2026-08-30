import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { AdapterName, registerOfficialAdapter } from "../src/profile/ObservabilityAdapter.ts";
import { InvalidObservabilityConfig } from "../src/profile/ObservabilityConfigError.ts";
import { validateAdapterRegistrationKinds } from "../src/profile/LifecycleRegistry.ts";

const validAdapter = {
  name: AdapterName.make("events"),
  capability: "events",
  stage: "server",
  start() {},
};

const invalidPayloads = [
  { field: "name", adapter: { ...validAdapter, name: "Bad Name!" } },
  { field: "capability", adapter: { ...validAdapter, capability: "unknown" } },
  { field: "stage", adapter: { ...validAdapter, stage: "later" } },
  { field: "start", adapter: { ...validAdapter, start: "not-callable" } },
];

describe("JavaScript adapter registration", () => {
  for (const fixture of invalidPayloads) {
    it(`returns a typed OBS error for invalid ${fixture.field}`, () => {
      let thrown;
      try {
        registerOfficialAdapter(fixture.adapter);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidObservabilityConfig);
      expect(thrown).toMatchObject({
        _tag: "InvalidObservabilityConfig",
        code: "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
        field: "adapters",
        rule: "a schema-valid adapter payload with a callable start",
      });
    });
  }

  for (const fixture of [
    {
      name: "spread copy",
      registration: { ...registerOfficialAdapter(validAdapter) },
    },
    {
      name: "plain structural registration",
      registration: { kind: "official", adapter: validAdapter },
    },
  ]) {
    it(`rejects a ${fixture.name} as an authenticity forgery`, async () => {
      const error = await Effect.runPromise(
        Effect.flip(
          validateAdapterRegistrationKinds([fixture.registration], { allowTesting: false }),
        ),
      );
      expect(error).toBeInstanceOf(InvalidObservabilityConfig);
      expect(error).toMatchObject({
        _tag: "InvalidObservabilityConfig",
        code: "OBS_OBSERVABILITY_ADAPTER_UNSUPPORTED",
        field: "adapters",
        message:
          "The adapter registration is not authentic. Use the package registration factories.",
      });
    });
  }
});
