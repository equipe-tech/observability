import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const packageVersion = "0.1.0";
const packagedAssetsDirectory = fileURLToPath(new URL("./assets", import.meta.url));

const StackEnvironment = Schema.Struct({
  OBSERVABILITY_HOME: Schema.NonEmptyString.pipe(Schema.optionalKey),
});

const decodeStackEnvironment = Schema.decodeUnknownEffect(StackEnvironment);

export class StackAssetsError extends Schema.TaggedError<StackAssetsError>()("StackAssetsError", {
  code: Schema.Literal("OBS_CLI_ASSETS_FAILED"),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const prepareStackAssets = Effect.fn("prepareStackAssets")(
  function* (sourceDirectory: string, stateDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const composeFile = path.join(stateDirectory, "docker-compose.yml");

    yield* fs.makeDirectory(path.join(stateDirectory, "data"), {
      recursive: true,
      mode: 0o700,
    });

    for (const file of ["docker-compose.yml", "local.yaml"]) {
      const content = yield* fs.readFileString(path.join(sourceDirectory, file));
      yield* fs.writeFileString(path.join(stateDirectory, file), content);
    }

    return composeFile;
  },
  Effect.mapError(
    (cause) =>
      new StackAssetsError({
        code: "OBS_CLI_ASSETS_FAILED",
        message:
          "The local stack assets could not be prepared. Check filesystem permissions and retry.",
        cause,
      }),
  ),
);

export class StackAssets extends Context.Service<
  StackAssets,
  {
    prepare(): Effect.Effect<string, StackAssetsError>;
  }
>()("@equipe-tech/observability-cli/StackAssets") {
  static readonly layer = Layer.effect(
    StackAssets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const environment = yield* decodeStackEnvironment(process.env).pipe(
        Effect.mapError(
          (cause) =>
            new StackAssetsError({
              code: "OBS_CLI_ASSETS_FAILED",
              message:
                "The local stack directory is invalid. Set OBSERVABILITY_HOME to a non-empty path.",
              cause,
            }),
        ),
      );
      const root =
        environment.OBSERVABILITY_HOME ?? path.join(homedir(), ".local", "state", "observability");
      const stateDirectory = path.join(root, packageVersion);

      return StackAssets.of({
        prepare: () =>
          prepareStackAssets(packagedAssetsDirectory, stateDirectory).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      });
    }),
  );
}
