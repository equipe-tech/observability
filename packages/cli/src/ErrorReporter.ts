import { Cause, Option, Predicate } from "effect";
import { CliError } from "effect/unstable/cli";

const unexpectedErrorMessage =
  "OBS_CLI_UNEXPECTED: The command failed unexpectedly. Retry the command. If the failure continues, contact support.";

export const publicErrorFromCause = (cause: Cause.Cause<unknown>): Option.Option<string> => {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    const value = error.value;
    if (
      CliError.isCliError(value) ||
      (Predicate.hasProperty(value, "_tag") &&
        (value._tag === "DockerComposeError" ||
          value._tag === "StackAssetsError" ||
          value._tag === "ProvisionError"))
    ) {
      return Option.none();
    }
  }
  return Option.some(unexpectedErrorMessage);
};
