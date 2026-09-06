import { describe, expect, it } from "bun:test";
import { enforceBundleGzipBudget } from "../scripts/package-smoke-budget.ts";

describe("package smoke bundle budget", () => {
  it("reports the hard ceiling before the margin", () => {
    expect(() =>
      enforceBundleGzipBudget({
        artifact: "The test bundle",
        deltaBytes: 101,
        ceilingBytes: 100,
      }),
    ).toThrow("The test bundle gzip delta is 101 bytes, above the 100 byte regression ceiling.");
  });

  it("reports the five-percent margin below the ceiling", () => {
    expect(() =>
      enforceBundleGzipBudget({
        artifact: "The test bundle",
        deltaBytes: 96,
        ceilingBytes: 100,
      }),
    ).toThrow(
      "The test bundle gzip delta is 96 bytes and leaves less than five percent margin below the 100 byte ceiling.",
    );
  });

  it("keeps the margin comparison strict", () => {
    expect(() =>
      enforceBundleGzipBudget({
        artifact: "The test bundle",
        deltaBytes: 95,
        ceilingBytes: 100,
      }),
    ).not.toThrow();
  });
});
