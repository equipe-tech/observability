import { describe, expect, it } from "vite-plus/test";
import * as Root from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";

describe("observability profile entrypoints", () => {
  it("keeps testing registrations out of the root entrypoint", () => {
    expect("registerOfficialAdapter" in Root).toBe(true);
    expect("registerTestingAdapter" in Root).toBe(false);
    expect("TestingAdapterRegistration" in Root).toBe(false);
    expect("registerTestingAdapter" in Testing).toBe(true);
    expect("createTestingNodeObservabilityFromConfig" in Testing).toBe(true);
  });
});
