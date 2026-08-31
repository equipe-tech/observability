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
          value._tag === "ProvisionError" ||
          value._tag === "CredentialsError" ||
          value._tag === "RemoteApiError" ||
          value._tag === "RemoteEnvironmentError" ||
          value._tag === "OperationsManifestError" ||
          value._tag === "ManagedQueryError" ||
          value._tag === "OperationsError" ||
          value._tag === "OperationsStateError"))
    ) {
      return Option.none();
    }
  }
  return Option.some(unexpectedErrorMessage);
};
