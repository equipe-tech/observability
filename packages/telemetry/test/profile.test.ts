import { describe, expect, it } from "vite-plus/test";
import {
  cliProfile,
  libraryProfile,
  nestjsApiProfile,
  observabilityProfiles,
  reactWebProfile,
  workerProfile,
} from "../src/profile/ObservabilityProfile.ts";

describe("official observability profiles", () => {
  it("exports exactly the five immutable descriptors", () => {
    expect([...observabilityProfiles.keys()]).toEqual([
      "nestjs-api",
      "worker",
      "react-web",
      "cli",
      "library",
    ]);
    expect(Object.isFrozen(nestjsApiProfile)).toBe(true);
    expect(Object.isFrozen(nestjsApiProfile.stages)).toBe(true);
  });

  it("matches the normative capability matrix", () => {
    const cells = [...observabilityProfiles.values()].map((profile) => [
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
    expect(workerProfile.stageDeadlineMillis.get("server")).toBe(5_000);
    expect(workerProfile.stageDeadlineMillis.get("metrics")).toBe(3_000);
    expect(reactWebProfile.stageDeadlineMillis.get("browser")).toBe(2_000);
    expect(workerProfile.capabilityOrder.get("server")).toEqual(["events", "traces", "defects"]);
    expect([
      nestjsApiProfile.shutdownDeadlineMillis,
      workerProfile.shutdownDeadlineMillis,
      reactWebProfile.shutdownDeadlineMillis,
      cliProfile.shutdownDeadlineMillis,
      libraryProfile.shutdownDeadlineMillis,
    ]).toEqual([5_000, 5_000, 2_000, 5_000, 0]);
  });
});
