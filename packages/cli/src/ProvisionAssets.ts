import { Context, Effect, Layer, Option, Schema } from "effect";
import { lstat, mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceName } from "./ResourceNamePolicy.ts";

const packagedAssetsDirectory = fileURLToPath(new URL("./assets", import.meta.url));

export const provisionDirectoryName = "observability";
export const provisionStatePath = `${provisionDirectoryName}/provision.json`;

export const QueueMode = Schema.Literals(["best-effort", "durable"]);
export type QueueMode = typeof QueueMode.Type;

const ProvisionStateAsset = Schema.Struct({
  path: Schema.String,
  digest: Schema.String,
});

const ProvisionState = Schema.Struct({
  version: Schema.Literal(1),
  queueMode: QueueMode,
  name: ServiceName,
  assets: Schema.Array(ProvisionStateAsset),
});

type ProvisionState = typeof ProvisionState.Type;

type ProvisionedAsset = {
  readonly source: "production.yaml" | "kamal.accessory.yml";
  readonly path: "observability/collector.yaml" | "observability/kamal.accessory.yml";
};

const provisionedAssets: ReadonlyArray<ProvisionedAsset> = [
  { source: "production.yaml", path: "observability/collector.yaml" },
  { source: "kamal.accessory.yml", path: "observability/kamal.accessory.yml" },
];

const decodeProjectName = Schema.decodeUnknownEffect(ServiceName);
const decodeQueueMode = Schema.decodeUnknownEffect(QueueMode);
const decodeProvisionState = Schema.decodeUnknownPromise(ProvisionState);

export class ProvisionError extends Schema.TaggedError<ProvisionError>()("ProvisionError", {
  code: Schema.Literals([
    "OBS_CLI_PROVISION_FAILED",
    "OBS_CLI_PROVISION_CONFLICT",
    "OBS_CLI_PROVISION_ASSET_INCOMPATIBLE",
    "OBS_CLI_PROVISION_INVALID_NAME",
    "OBS_CLI_PROVISION_INVALID_QUEUE_MODE",
  ]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ProvisionedFileAction = "created" | "updated" | "unchanged";

export type ProvisionedFile = {
  readonly relativePath: string;
  readonly action: ProvisionedFileAction;
};

type RenderedAsset = ProvisionedAsset & {
  readonly content: string;
  readonly digest: string;
};

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

export const parseQueueMode = Effect.fn("parseQueueMode")(function* (
  mode: string,
): Effect.fn.Return<QueueMode, ProvisionError> {
  return yield* decodeQueueMode(mode).pipe(
    Effect.mapError(
      (cause) =>
        new ProvisionError({
          code: "OBS_CLI_PROVISION_INVALID_QUEUE_MODE",
          message: "The queue mode is invalid. Use best-effort or durable.",
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

const provisionConflict = (paths: ReadonlyArray<string>): ProvisionError =>
  new ProvisionError({
    code: "OBS_CLI_PROVISION_CONFLICT",
    message: `The provisioned bundle conflicts at ${paths.join(", ")}. Review the local files and rerun with --force to replace the complete bundle. No files were written.`,
    cause: paths,
  });

const incompatibleProvisionAsset = (cause: unknown): ProvisionError =>
  new ProvisionError({
    code: "OBS_CLI_PROVISION_ASSET_INCOMPATIBLE",
    message:
      "The packaged observability assets do not match the queue-mode renderer. Install a compatible CLI package and retry.",
    cause,
  });

const digest = (content: string): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");

const replaceExpected = (
  content: string,
  expected: string,
  replacement: string,
  count: number,
): string => {
  if (content.split(expected).length - 1 !== count)
    throw incompatibleProvisionAsset(`Packaged asset marker count changed for ${expected}`);
  return content.replaceAll(expected, replacement);
};

const bestEffortCollector = (durable: string): string => {
  let rendered = replaceExpected(
    durable,
    "  file_storage/queue:\n    directory: /var/lib/otelcol/queue\n    create_directory: true\n    max_size: 2147483648\n    fsync: true\n    recreate: false\n",
    "",
    1,
  );
  rendered = replaceExpected(rendered, "      storage: file_storage/queue\n", "", 3);
  rendered = replaceExpected(
    rendered,
    "      max_elapsed_time: 0\n",
    "      max_elapsed_time: 5m\n",
    3,
  );
  return replaceExpected(
    rendered,
    "  extensions: [file_storage/queue, health_check]\n",
    "  extensions: [health_check]\n",
    1,
  );
};

const bestEffortAccessory = (durable: string): string =>
  replaceExpected(
    durable,
    '    directories:\n      - local: /var/lib/observability/{{name}}/collector/queue\n        remote: /var/lib/otelcol/queue\n        mode: "0700"\n        owner: "10001:10001"\n',
    "",
    1,
  );

const renderAssets = async (sourceDirectory: string, name: string, mode: QueueMode) => {
  const rendered: Array<RenderedAsset> = [];
  for (const asset of provisionedAssets) {
    const template = await readFile(join(sourceDirectory, asset.source), "utf8");
    const selected =
      mode === "durable"
        ? template
        : asset.source === "production.yaml"
          ? bestEffortCollector(template)
          : bestEffortAccessory(template);
    const content = selected.replaceAll("{{name}}", name);
    rendered.push({ ...asset, content, digest: digest(content) });
  }
  return rendered;
};

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
};

const assertSafePaths = async (root: string, paths: ReadonlyArray<string>): Promise<void> => {
  const candidates = new Map<string, "file" | "directory">([[root, "directory"]]);
  let rootAncestor = dirname(root);
  while (true) {
    candidates.set(rootAncestor, "directory");
    const parent = dirname(rootAncestor);
    if (parent === rootAncestor) break;
    rootAncestor = parent;
  }
  for (const path of paths) {
    const destination = resolve(root, path);
    const rooted = relative(root, destination);
    if (isAbsolute(path) || rooted === "" || rooted === ".." || rooted.startsWith(`..${sep}`))
      throw provisionConflict([path]);
    candidates.set(destination, "file");
    let current = dirname(destination);
    while (true) {
      candidates.set(current, "directory");
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const [candidate, kind] of [...candidates].sort(
    ([left], [right]) => left.length - right.length,
  )) {
    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || (kind === "file" && entry.nlink > 1))
        throw provisionConflict([relative(root, candidate) || root]);
      if (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
        throw provisionConflict([relative(root, candidate) || root]);
    } catch (cause) {
      if (cause instanceof ProvisionError) throw cause;
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
  }
};

const canonicalTarget = async (directory: string): Promise<string> => {
  const requested = resolve(directory);
  if (process.platform !== "darwin") return requested;
  for (const prefix of ["/tmp", "/var", "/etc"]) {
    if (requested !== prefix && !requested.startsWith(`${prefix}/`)) continue;
    if ((await lstat(prefix)).isSymbolicLink() && (await readlink(prefix)) === `private${prefix}`)
      return `/private${requested}`;
  }
  return requested;
};

const atomicWrite = async (root: string, relativePath: string, content: string): Promise<void> => {
  await assertSafePaths(root, [relativePath]);
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await assertSafePaths(root, [relativePath]);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await assertSafePaths(root, [relativePath]);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
};

const sameAssetList = (state: ProvisionState, rendered: ReadonlyArray<RenderedAsset>): boolean =>
  state.assets.length === rendered.length &&
  state.assets.every((asset, index) => asset.path === rendered[index]?.path);

const stateContent = (
  name: string,
  queueMode: QueueMode,
  assets: ReadonlyArray<RenderedAsset>,
): string =>
  `${JSON.stringify(
    {
      version: 1,
      queueMode,
      name,
      assets: assets.map((asset) => ({ path: asset.path, digest: asset.digest })),
    } satisfies ProvisionState,
    undefined,
    2,
  )}\n`;

export type ProvisionAssetsObservation = {
  readonly fingerprint: string;
  readonly paths: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<string>;
};

export const observeProvisionAssets = Effect.fn("observeProvisionAssets")(function* (
  targetDirectory: string,
  name: string,
  queueMode: QueueMode,
): Effect.fn.Return<ProvisionAssetsObservation, ProvisionError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const root = await canonicalTarget(targetDirectory);
      const rendered = await renderAssets(packagedAssetsDirectory, name, queueMode);
      const paths = [...rendered.map((asset) => asset.path), provisionStatePath];
      await assertSafePaths(root, paths);
      const current = await Promise.all(paths.map((path) => readText(join(root, path))));
      const desiredContent = [
        ...rendered.map((asset) => asset.content),
        stateContent(name, queueMode, rendered),
      ];
      return {
        fingerprint: digest(
          JSON.stringify({
            name,
            queueMode,
            desired: rendered.map((asset) => ({ path: asset.path, digest: asset.digest })),
            current: paths.map((path, index) => ({
              path,
              digest: current[index] === undefined ? "absent" : digest(current[index]),
            })),
          }),
        ),
        paths,
        changes: paths.filter((_, index) => current[index] !== desiredContent[index]),
      };
    },
    catch: (cause) => (cause instanceof ProvisionError ? cause : provisionFailure(cause)),
  });
});

export const provisionAssets = Effect.fn("provisionAssets")(function* (
  sourceDirectory: string,
  targetDirectory: string,
  name: string,
  queueMode: QueueMode,
  force: boolean,
): Effect.fn.Return<ReadonlyArray<ProvisionedFile>, ProvisionError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const root = await canonicalTarget(targetDirectory);
      const rendered = await renderAssets(sourceDirectory, name, queueMode);
      const managedPaths = [...rendered.map((asset) => asset.path), provisionStatePath];
      await assertSafePaths(root, managedPaths);
      const currentAssets = await Promise.all(
        rendered.map((asset) => readText(join(root, asset.path))),
      );
      const currentStateContent = await readText(join(root, provisionStatePath));
      let state: ProvisionState | undefined;
      if (currentStateContent !== undefined) {
        try {
          state = await decodeProvisionState(JSON.parse(currentStateContent));
        } catch {
          if (!force) throw provisionConflict([provisionStatePath]);
        }
      }

      const adoptableWithoutState =
        state === undefined &&
        currentAssets.every(
          (content, index) => content === undefined || content === rendered[index]?.content,
        );
      if (!adoptableWithoutState && state === undefined && !force)
        throw provisionConflict(
          rendered
            .filter((asset, index) => currentAssets[index] !== asset.content)
            .map((asset) => asset.path),
        );

      if (state !== undefined) {
        const identityMatches = sameAssetList(state, rendered) && state.name === name;
        if (!identityMatches && !force) throw provisionConflict([provisionStatePath]);
        if (state.queueMode !== queueMode && !force) throw provisionConflict(managedPaths);
        if (identityMatches) {
          const conflicts = rendered.filter((asset, index) => {
            const current = currentAssets[index];
            const recorded = state?.assets[index];
            return (
              current !== asset.content &&
              current !== undefined &&
              (recorded === undefined || digest(current) !== recorded.digest)
            );
          });
          if (conflicts.length > 0 && !force)
            throw provisionConflict(conflicts.map((asset) => asset.path));
        }
      }

      const nextState = stateContent(name, queueMode, rendered);
      const results: Array<ProvisionedFile> = [];
      for (const [index, asset] of rendered.entries()) {
        const current = currentAssets[index];
        const action: ProvisionedFileAction =
          current === undefined ? "created" : current === asset.content ? "unchanged" : "updated";
        results.push({ relativePath: asset.path, action });
      }
      results.push({
        relativePath: provisionStatePath,
        action:
          currentStateContent === undefined
            ? "created"
            : currentStateContent === nextState
              ? "unchanged"
              : "updated",
      });

      for (const [index, asset] of rendered.entries()) {
        if (currentAssets[index] !== asset.content)
          await atomicWrite(root, asset.path, asset.content);
      }
      if (currentStateContent !== nextState) await atomicWrite(root, provisionStatePath, nextState);
      return results;
    },
    catch: (cause) => (cause instanceof ProvisionError ? cause : provisionFailure(cause)),
  });
});

const resolveProvisionName = Effect.fn("ProvisionAssets.resolveName")(function* (
  directory: string,
  name: Option.Option<string>,
) {
  const resolved = resolve(directory);
  return yield* Option.match(name, {
    onNone: () => projectNameFromDirectory(basename(resolved)),
    onSome: parseProjectName,
  });
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
      queueMode: QueueMode,
      force: boolean,
    ): Effect.Effect<ReadonlyArray<ProvisionedFile>, ProvisionError>;
  }
>()("@equipe-tech/observability-cli/ProvisionAssets") {
  static readonly layer = Layer.succeed(
    ProvisionAssets,
    ProvisionAssets.of({
      resolveName: resolveProvisionName,
      provision: (directory, name, queueMode, force) =>
        Effect.gen(function* () {
          const resolved = resolve(directory);
          const projectName = yield* resolveProvisionName(directory, name);
          return yield* provisionAssets(
            packagedAssetsDirectory,
            resolved,
            projectName,
            queueMode,
            force,
          );
        }),
    }),
  );
}
