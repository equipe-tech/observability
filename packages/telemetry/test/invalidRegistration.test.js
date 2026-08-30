import { describe, expect, it } from "vite-plus/test";
import { AdapterName, registerOfficialAdapter } from "../src/profile/ObservabilityAdapter.ts";
import { InvalidObservabilityConfig } from "../src/profile/ObservabilityConfigError.ts";

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
        rule: "a schema-valid adapter payload",
      });
    });
  }
});
