import { Effect, Schema } from "effect";
import { format } from "oxfmt";
import { Contract } from "../packages/telemetry/src/index.ts";

const decodeDocument = Schema.decodeUnknownEffect(Contract.ContractSurfaceSchema, {
  onExcessProperty: "error",
});

export class CompatibilityJsonDecodeError extends Schema.TaggedError<CompatibilityJsonDecodeError>()(
  "CompatibilityJsonDecodeError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const decodeCompatibilityJson = Effect.fn("decodeCompatibilityJson")(function* (
  content: string,
) {
  const document = yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) =>
      new CompatibilityJsonDecodeError({
        message: "Compatibility artifact is not valid JSON.",
        cause,
      }),
  });
  return yield* decodeDocument(document).pipe(
    Effect.mapError(
      (cause) =>
        new CompatibilityJsonDecodeError({
          message: "Compatibility artifact does not match contract surface version 1.",
          cause,
        }),
    ),
  );
});

export const encodeCompatibilityJson = async <Value>(value: Value): Promise<string> => {
  const result = await format("compatibility.json", JSON.stringify(value));
  if (result.errors.length > 0)
    throw new Error(`Compatibility artifact formatting failed: ${result.errors[0]?.message}`);
  return result.code;
};
