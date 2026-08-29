import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { ServiceName } from "./ResourceNamePolicy.ts";

const packagedAssetsDirectory = fileURLToPath(new URL("./assets", import.meta.url));

export const provisionDirectoryName = "observability";

const decodeProjectName = Schema.decodeUnknownEffect(ServiceName);

export class ProvisionError extends Schema.TaggedError<ProvisionError>()("ProvisionError", {
  code: Schema.Literals([
    "OBS_CLI_PROVISION_FAILED",
    "OBS_CLI_PROVISION_CONFLICT",
    "OBS_CLI_PROVISION_INVALID_NAME",
  ]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ProvisionedFileAction = "created" | "updated" | "unchanged";

export type ProvisionedFile = {
  readonly relativePath: string;
  readonly action: ProvisionedFileAction;
};

const provisionedAssets = [
  { asset: "production.yaml", target: "collector.yaml" },
  { asset: "kamal.accessory.yml", target: "kamal.accessory.yml" },
];

const normalizeProjectName = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[\s_.]+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

export const projectNameFromDirectory = Effect.fn("projectNameFromDirectory")(function* (
  directoryName: string,
): Effect.fn.Return<string, ProvisionError> {
  return yield* decodeProjectName(normalizeProjectName(directoryName)).pipe(
    Effect.mapError(
      (cause) =>
        new ProvisionError({
          code: "OBS_CLI_PROVISION_INVALID_NAME",
          message:
            "The project name could not be derived from the target directory. Pass --name with lowercase letters, digits and single hyphens between segments.",
          cause,
        }),
    ),
  );
});

export const parseProjectName = Effect.fn("parseProjectName")(function* (
  name: string,
): Effect.fn.Return<string, ProvisionError> {
  return yield* decodeProjectName(name).pipe(
    Effect.mapError(
      (cause) =>
        new ProvisionError({
          code: "OBS_CLI_PROVISION_INVALID_NAME",
          message:
            "The project name is invalid. Use lowercase letters, digits and single hyphens between segments, with at most 63 characters.",
          cause,
        }),
    ),
  );
});

const provisionFailure = (cause: unknown): ProvisionError =>
  new ProvisionError({
    code: "OBS_CLI_PROVISION_FAILED",
    message:
      "The observability assets could not be provisioned. Check filesystem permissions on the target directory and retry.",
    cause,
  });

export const provisionAssets = Effect.fn("provisionAssets")(function* (
  sourceDirectory: string,
  targetDirectory: string,
  name: string,
  force: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputDirectory = path.join(targetDirectory, provisionDirectoryName);
  yield* fs
    .makeDirectory(outputDirectory, { recursive: true })
    .pipe(Effect.mapError(provisionFailure));

  const provisioned: Array<ProvisionedFile> = [];
  for (const { asset, target } of provisionedAssets) {
    const relativePath = `${provisionDirectoryName}/${target}`;
    const template = yield* fs
      .readFileString(path.join(sourceDirectory, asset))
      .pipe(Effect.mapError(provisionFailure));
    const rendered = template.replaceAll("{{name}}", name);
    const targetFile = path.join(outputDirectory, target);
    const exists = yield* fs.exists(targetFile).pipe(Effect.mapError(provisionFailure));

    if (exists) {
      const current = yield* fs.readFileString(targetFile).pipe(Effect.mapError(provisionFailure));
      if (current === rendered) {
        provisioned.push({ relativePath, action: "unchanged" });
        continue;
      }
      if (!force) {
        return yield* new ProvisionError({
          code: "OBS_CLI_PROVISION_CONFLICT",
          message: `The file ${relativePath} differs from the packaged asset. Review the local changes and rerun with --force to overwrite.`,
          cause: relativePath,
        });
      }
      yield* fs.writeFileString(targetFile, rendered).pipe(Effect.mapError(provisionFailure));
      provisioned.push({ relativePath, action: "updated" });
      continue;
    }

    yield* fs.writeFileString(targetFile, rendered).pipe(Effect.mapError(provisionFailure));
    provisioned.push({ relativePath, action: "created" });
  }
  return provisioned;
});

export class ProvisionAssets extends Context.Service<
  ProvisionAssets,
  {
    resolveName(
      directory: string,
      name: Option.Option<string>,
    ): Effect.Effect<string, ProvisionError>;
    provision(
      directory: string,
      name: Option.Option<string>,
      force: boolean,
    ): Effect.Effect<ReadonlyArray<ProvisionedFile>, ProvisionError>;
  }
>()("@equipe-tech/observability-cli/ProvisionAssets") {
  static readonly layer = Layer.effect(
    ProvisionAssets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const resolveName = Effect.fn("ProvisionAssets.resolveName")(function* (
        directory: string,
        name: Option.Option<string>,
      ) {
        const resolved = path.resolve(directory);
        return yield* Option.match(name, {
          onNone: () => projectNameFromDirectory(path.basename(resolved)),
          onSome: parseProjectName,
        });
      });

      return ProvisionAssets.of({
        resolveName,
        provision: (directory, name, force) =>
          Effect.gen(function* () {
            const resolved = path.resolve(directory);
            const projectName = yield* resolveName(directory, name);
            return yield* provisionAssets(packagedAssetsDirectory, resolved, projectName, force);
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      });
    }),
  );
}
