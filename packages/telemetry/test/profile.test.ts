import { describe, expect, it } from "vite-plus/test";
import { reactWebLifecycle } from "../src/profile/ReactWebProfile.ts";
import {
  cliProfile,
  libraryProfile,
  nestjsApiProfile,
  observabilityProfiles,
  reactWebProfile,
  workerProfile,
  profileStageDeadlineMillis,
} from "../src/profile/ObservabilityProfile.ts";

describe("official observability profiles", () => {
  it("exports exactly the five immutable descriptors", () => {
    expect(Object.keys(observabilityProfiles)).toEqual([
      "nestjs-api",
      "worker",
      "react-web",
      "cli",
      "library",
    ]);
    expect(Object.isFrozen(observabilityProfiles)).toBe(true);
    expect(Object.isFrozen(nestjsApiProfile)).toBe(true);
    expect(Object.isFrozen(nestjsApiProfile.stages)).toBe(true);
    expect(Object.isFrozen(workerProfile.stageDeadlineMillis)).toBe(true);
    expect(Object.isFrozen(workerProfile.stageDeadlineMillis[0])).toBe(true);
    expect(Object.isFrozen(workerProfile.capabilityOrder)).toBe(true);
    expect(Object.isFrozen(workerProfile.capabilityOrder[0])).toBe(true);
    const serverOrder = workerProfile.capabilityOrder[0];
    if (serverOrder === undefined) throw new Error("Expected the worker server capability order.");
    expect(Object.isFrozen(serverOrder[1])).toBe(true);
    expect("set" in workerProfile.stageDeadlineMillis).toBe(false);
    expect(() => Object.defineProperty(serverOrder[1], 0, { value: "metrics" })).toThrow(TypeError);
  });

  it("matches the normative capability matrix", () => {
    const cells = Object.values(observabilityProfiles).map((profile) => [
      profile.name,
      profile.events,
      profile.traces,
      profile.metrics,
      profile.defects,
      profile.browserIngest,
    ]);
    expect(cells).toEqual([
      ["nestjs-api", "required", "required", "required", "required-in-production", "optional"],
      ["worker", "required", "required", "required", "required-in-production", "forbidden"],
      ["react-web", "required", "required", "optional", "required-in-production", "required"],
      ["cli", "required", "optional", "optional", "optional", "forbidden"],
      ["library", "forbidden", "forbidden", "forbidden", "forbidden", "forbidden"],
    ]);
  });

  it("publishes nested absolute deadlines", () => {
    expect(profileStageDeadlineMillis(workerProfile, "server")).toBe(5_000);
    expect(profileStageDeadlineMillis(workerProfile, "metrics")).toBe(3_000);
    expect(profileStageDeadlineMillis(reactWebProfile, "browser")).toBe(
      reactWebLifecycle.shutdownDeadlineMillis,
    );
    expect(reactWebProfile.shutdownDeadlineMillis).toBe(reactWebLifecycle.shutdownDeadlineMillis);
    expect(workerProfile.capabilityOrder[0]).toEqual(["server", ["events", "traces", "defects"]]);
    expect([
      nestjsApiProfile.shutdownDeadlineMillis,
      workerProfile.shutdownDeadlineMillis,
      reactWebProfile.shutdownDeadlineMillis,
      cliProfile.shutdownDeadlineMillis,
      libraryProfile.shutdownDeadlineMillis,
    ]).toEqual([5_000, 5_000, 2_000, 5_000, 0]);
  });
});
