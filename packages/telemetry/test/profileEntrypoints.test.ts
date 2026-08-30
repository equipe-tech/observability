import { describe, expect, it } from "vite-plus/test";
import * as Node from "../src/node/index.ts";
import * as Root from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";
import type { LifecycleCleanupResult as NodeLifecycleCleanupResult } from "../src/node/index.ts";
import type { LifecycleCleanupResult as RootLifecycleCleanupResult } from "../src/index.ts";

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

  it("exports the cleanup result type from root and Node entrypoints", () => {
    const rootResult: RootLifecycleCleanupResult = { kind: "completed", durationMillis: 1 };
    const nodeResult: NodeLifecycleCleanupResult = rootResult;
    expect(nodeResult).toEqual(rootResult);
  });
});
