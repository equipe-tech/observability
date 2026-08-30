import { describe, expect, test } from "bun:test";
import { classifyNpmView } from "../../../scripts/npm-publication-state.ts";

describe("npm publication state", () => {
  test("classifies an existing version as published", () => {
    expect(classifyNpmView({ exitCode: 0, stdout: '"0.3.0"', stderr: "" })).toBe("published");
  });

  test("classifies only npm not-found responses as missing", () => {
    expect(classifyNpmView({ exitCode: 1, stdout: "", stderr: "npm error code E404" })).toBe(
      "missing",
    );
  });

  test.each([
    ["network", "npm error code ENETUNREACH"],
    ["authentication", "npm error code E401"],
    ["authorization", "npm error code E403"],
  ])("rejects %s failures", (_name, stderr) => {
    expect(() => classifyNpmView({ exitCode: 1, stdout: "", stderr })).toThrow(
      "npm view failed with exit code 1",
    );
  });
});
