import { Context, Effect, Layer, Schema } from "effect";
import { SetupError } from "./setup/SetupGenerator.ts";

const ApplicationCanaryEnvironment = Schema.Struct({
  OBSERVABILITY_APPLICATION_CANARY_COMMAND: Schema.NonEmptyString.pipe(Schema.optionalKey),
});
const applicationCanaryEnvironment = Schema.decodeUnknownSync(ApplicationCanaryEnvironment)(
  process.env,
);

const runApplicationCanary = Effect.fn("ApplicationCanary.run")(function* () {
  const command = applicationCanaryEnvironment.OBSERVABILITY_APPLICATION_CANARY_COMMAND;
  if (command === undefined)
    return yield* new SetupError({
      code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
      message:
        "OBSERVABILITY_APPLICATION_CANARY_COMMAND is required. Bind the application production canary command and retry.",
      cause: "missing application canary command",
    });
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn(["bash", "-lc", command], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          detached: process.platform !== "win32",
        }),
      catch: (cause) =>
        new SetupError({
          code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
          message:
            "The application production canary command could not start. Correct it and retry.",
          cause,
        }),
    }),
    (child) =>
      Effect.tryPromise({
        try: () => child.exited,
        catch: (cause) =>
          new SetupError({
            code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
            message:
              "The application production canary command could not complete. Correct it and retry.",
            cause,
          }),
      }).pipe(
        Effect.timeout("5 minutes"),
        Effect.mapError((cause) =>
          cause instanceof SetupError
            ? cause
            : new SetupError({
                code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
                message:
                  "The application production canary command timed out. Correct it and retry.",
                cause,
              }),
        ),
        Effect.flatMap((exitCode) =>
          exitCode === 0
            ? Effect.void
            : new SetupError({
                code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
                message: `The application production canary command exited with code ${exitCode}. Correct it and retry.`,
                cause: exitCode,
              }),
        ),
      ),
    (child) =>
      Effect.sync(() => {
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill();
          }
        } else child.kill();
      }),
  );
});

export class ApplicationCanary extends Context.Service<
  ApplicationCanary,
  { readonly run: Effect.Effect<void, SetupError> }
>()("@equipe-tech/observability-cli/ApplicationCanary") {
  static readonly layer = Layer.succeed(
    ApplicationCanary,
    ApplicationCanary.of({ run: runApplicationCanary() }),
  );
}
