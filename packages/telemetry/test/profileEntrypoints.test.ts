import { describe, expect, it } from "vite-plus/test";
import * as Node from "../src/node/index.ts";
import * as Root from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";

describe("observability profile entrypoints", () => {
  it("keeps testing registrations out of the root entrypoint", () => {
    expect("registerOfficialAdapter" in Root).toBe(true);
    expect("registerTestingAdapter" in Root).toBe(false);
    expect("registerTestingAdapter" in Testing).toBe(true);
    expect("createTestingNodeObservabilityFromConfig" in Testing).toBe(true);
  });

  it("exports the lifecycle error value from public runtime entrypoints", () => {
    expect(Root.ObservabilityLifecycleError).toBeDefined();
    expect(Node.ObservabilityLifecycleError).toBe(Root.ObservabilityLifecycleError);
  });
});
