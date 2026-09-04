import { Schema } from "effect";

export class ConformanceFixtureError extends Schema.TaggedError<ConformanceFixtureError>()(
  "ConformanceFixtureError",
  {
    code: Schema.Literal("OBS_CONFORMANCE_FIXTURE_INVALID"),
    message: Schema.String,
  },
) {}

export const fixtureError = (message: string): ConformanceFixtureError =>
  new ConformanceFixtureError({ code: "OBS_CONFORMANCE_FIXTURE_INVALID", message });
