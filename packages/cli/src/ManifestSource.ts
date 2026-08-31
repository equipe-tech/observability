import { Effect, Option, Schema } from "effect";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ManagedQueryError,
  OperationsManifestError,
  parseOperationsContractIndex,
  parseOperationsManifest,
  validateOperationsManifest,
  type ValidatedOperationsManifest,
} from "./OperationsManifest.ts";
import { OperationsError } from "./OperationsPlan.ts";

const FileReadFailure = Schema.Struct({ code: Schema.String });
const decodeFileReadFailure = Schema.decodeUnknownOption(FileReadFailure);

const readDocument = Effect.fn("readOperationsDocument")(function* (
  path: string,
  kind: "manifest" | "contract",
): Effect.fn.Return<string, OperationsManifestError> {
  return yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => {
      const failure = decodeFileReadFailure(cause);
      const missing = Option.isSome(failure) && failure.value.code === "ENOENT";
      const code =
        kind === "manifest"
          ? missing
            ? "OBS_CLI_MANIFEST_NOT_FOUND"
            : "OBS_CLI_MANIFEST_UNREADABLE"
          : missing
            ? "OBS_CLI_CONTRACT_INDEX_NOT_FOUND"
            : "OBS_CLI_CONTRACT_INDEX_INVALID";
      return new OperationsManifestError({
        code,
        message:
          kind === "manifest"
            ? "observability/operations.yaml was not found or could not be read."
            : "observability/contract.json was not found or could not be read.",
        issues: [`unreadable ${kind}`],
        cause,
      });
    },
  });
});

export const persistOperationsPlan = Effect.fn("persistOperationsPlan")(function* (
  directory: string,
  digest: string,
  content: string,
): Effect.fn.Return<string, OperationsError> {
  const outputDirectory = resolve(directory, ".observability");
  const outputPath = resolve(outputDirectory, `plan-${digest}.json`);
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await chmod(outputDirectory, 0o700);
      await writeFile(outputPath, content, { mode: 0o600 });
      await chmod(outputPath, 0o600);
    },
    catch: (cause) =>
      new OperationsError({
        code: "OBS_CLI_PLAN_INVALID",
        message: "The operations plan could not be persisted. Check directory permissions.",
        cause,
      }),
  });
  return outputPath;
});

export const readOperationsPlan = Effect.fn("readOperationsPlan")(function* (
  planPath: string,
): Effect.fn.Return<string, OperationsError> {
  return yield* Effect.tryPromise({
    try: () => readFile(resolve(planPath), "utf8"),
    catch: (cause) =>
      new OperationsError({
        code: "OBS_CLI_PLAN_REQUIRED",
        message: "Apply requires a readable plan file produced by ops plan.",
        cause,
      }),
  });
});

export const loadOperationsManifest = Effect.fn("loadOperationsManifest")(function* (
  directory: string,
): Effect.fn.Return<ValidatedOperationsManifest, OperationsManifestError | ManagedQueryError> {
  const root = resolve(directory);
  const manifestContent = yield* readDocument(
    resolve(root, "observability", "operations.yaml"),
    "manifest",
  );
  const manifest = yield* parseOperationsManifest(manifestContent);
  const contractContent = yield* readDocument(
    resolve(root, "observability", "contract.json"),
    "contract",
  );
  const contract = yield* parseOperationsContractIndex(contractContent);
  return yield* validateOperationsManifest(manifest, contract);
});
