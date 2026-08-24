import { describe, expect, test } from "bun:test";
import { Cause, Option } from "effect";
import { publicErrorFromCause } from "../src/ErrorReporter.ts";

describe("publicErrorFromCause", () => {
  test("renders defects without private diagnostic details", () => {
    const message = Option.getOrUndefined(
      publicErrorFromCause(Cause.die(new Error("private /workspace/source.ts:42"))),
    );

    expect(message).toContain("OBS_CLI_UNEXPECTED");
    expect(message).not.toContain("private");
    expect(message).not.toContain("source.ts");
  });
});
