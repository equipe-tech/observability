import { describe, expect, test } from "bun:test";
import { classifyAxiomRetentionChange } from "../src/AxiomDatasetRetention.ts";

describe("Axiom dataset retention", () => {
  test.each([
    ["confirmed absence", [], 30, "manual"],
    ["disabled with omitted days", [{ useRetentionPeriod: false }], 30, "destructive"],
    [
      "disabled with provider-default zero days",
      [{ retentionDays: 0, useRetentionPeriod: false }],
      30,
      "destructive",
    ],
    [
      "finite preservation increase",
      [{ retentionDays: 7, useRetentionPeriod: true }],
      30,
      "manual",
    ],
    ["equal finite preservation", [{ retentionDays: 30, useRetentionPeriod: true }], 30, "manual"],
    [
      "finite preservation decrease",
      [{ retentionDays: 90, useRetentionPeriod: true }],
      30,
      "destructive",
    ],
    [
      "mixed finite and unbounded preservation",
      [
        { retentionDays: 7, useRetentionPeriod: true },
        { retentionDays: 0, useRetentionPeriod: false },
      ],
      30,
      "destructive",
    ],
    ["unknown enabled preservation", [{ useRetentionPeriod: true }], 30, "destructive"],
  ] as const)("classifies %s", (_name, observed, desiredDays, expected) => {
    expect(classifyAxiomRetentionChange(observed, desiredDays)).toBe(expected);
  });
});
