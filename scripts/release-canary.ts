import { Effect, Schema } from "effect";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const ReleaseTag = Schema.String.check(
  Schema.isPattern(/^[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/),
);

const ReleaseCredentialName = Schema.Literals(["AXIOM_INGEST_TOKEN", "AXIOM_READ_TOKEN"]);
export type ReleaseCredentialName = typeof ReleaseCredentialName.Type;

const ReleaseCanaryErrorCode = Schema.Literals([
  "OBS_RELEASE_CANARY_ARGUMENTS_INVALID",
  "OBS_RELEASE_CANARY_TAG_INVALID",
  "OBS_RELEASE_CANARY_MANIFEST_INVALID",
  "OBS_RELEASE_CANARY_PACKAGE_UNKNOWN",
  "OBS_RELEASE_CANARY_VERSION_MISMATCH",
  "OBS_RELEASE_CANARY_CREDENTIALS_MISSING",
  "OBS_RELEASE_CANARY_OUTPUT_FAILED",
  "OBS_RELEASE_CANARY_UNEXPECTED",
]);

export class ReleaseCanaryError extends Schema.TaggedError<ReleaseCanaryError>()(
  "ReleaseCanaryError",
  {
    code: ReleaseCanaryErrorCode,
    message: Schema.String,
    correlationId: Schema.NonEmptyString,
    cause: Schema.Defect(),
  },
) {}

export class ReleaseCanaryIdentity extends Schema.Class<ReleaseCanaryIdentity>(
  "@equipe-tech/observability/ReleaseCanaryIdentity",
)({
  releaseTag: ReleaseTag,
  packageName: Schema.NonEmptyString,
  packageSlug: Schema.NonEmptyString,
  packageVersion: Schema.NonEmptyString,
  otelServiceVersion: Schema.NonEmptyString,
}) {}

const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

const decodeReleaseTag = Schema.decodeUnknownEffect(ReleaseTag);
const decodePackageManifest = Schema.decodeUnknownEffect(PackageManifest);
const decodeCredentialName = Schema.decodeUnknownEffect(ReleaseCredentialName);
const decodeCredentialValue = Schema.decodeUnknownEffect(Schema.NonEmptyString);

const withCorrelation = (message: string, correlationId: string): string =>
  `${message} Correlation ID: ${correlationId}.`;

const releaseCanaryError = (
  code: typeof ReleaseCanaryErrorCode.Type,
  message: string,
  correlationId: string,
  cause: unknown,
): ReleaseCanaryError =>
  new ReleaseCanaryError({
    code,
    message: withCorrelation(message, correlationId),
    correlationId,
    cause,
  });

export const resolveReleaseCanaryIdentity = Effect.fn("resolveReleaseCanaryIdentity")(function* (
  root: string,
  releaseTag: string,
  correlationId = crypto.randomUUID(),
) {
  const tag = yield* decodeReleaseTag(releaseTag).pipe(
    Effect.mapError((cause) =>
      releaseCanaryError(
        "OBS_RELEASE_CANARY_TAG_INVALID",
        "The release tag does not match the scoped package release format.",
        correlationId,
        cause,
      ),
    ),
  );
  const separatorIndex = tag.lastIndexOf("@");
  const slug = tag.slice(0, separatorIndex);
  const packageVersion = tag.slice(separatorIndex + 1);
  const packageDirectories = yield* Effect.tryPromise({
    try: () => Array.fromAsync(new Bun.Glob("packages/*/package.json").scan(root)),
    catch: (cause) =>
      releaseCanaryError(
        "OBS_RELEASE_CANARY_MANIFEST_INVALID",
        "Package manifests could not be listed.",
        correlationId,
        cause,
      ),
  });
  for (const relativePath of packageDirectories) {
    const manifestValue = yield* Effect.tryPromise({
      try: () => Bun.file(join(root, relativePath)).json(),
      catch: (cause) =>
        releaseCanaryError(
          "OBS_RELEASE_CANARY_MANIFEST_INVALID",
          "A package manifest could not be read.",
          correlationId,
          cause,
        ),
    });
    const manifest = yield* decodePackageManifest(manifestValue).pipe(
      Effect.mapError((cause) =>
        releaseCanaryError(
          "OBS_RELEASE_CANARY_MANIFEST_INVALID",
          "A package manifest is malformed.",
          correlationId,
          cause,
        ),
      ),
    );
    if (manifest.name.replace(/^@equipe-tech\//, "") !== slug) continue;
    if (manifest.version !== packageVersion) {
      return yield* releaseCanaryError(
        "OBS_RELEASE_CANARY_VERSION_MISMATCH",
        `The release tag ${tag} does not match package version ${manifest.version}.`,
        correlationId,
        manifest,
      );
    }
    return new ReleaseCanaryIdentity({
      releaseTag: tag,
      packageName: manifest.name,
      packageSlug: slug,
      packageVersion,
      otelServiceVersion: packageVersion,
    });
  }
  return yield* releaseCanaryError(
    "OBS_RELEASE_CANARY_PACKAGE_UNKNOWN",
    `The release tag ${tag} selects an unknown package.`,
    correlationId,
    tag,
  );
});

export const requireReleaseCanaryCredential = Effect.fn("requireReleaseCanaryCredential")(
  function* (
    environment: NodeJS.ProcessEnv,
    credentialInput: string,
    correlationId = crypto.randomUUID(),
  ) {
    const credential = yield* decodeCredentialName(credentialInput).pipe(
      Effect.mapError((cause) =>
        releaseCanaryError(
          "OBS_RELEASE_CANARY_ARGUMENTS_INVALID",
          "The requested release canary credential name is invalid.",
          correlationId,
          cause,
        ),
      ),
    );
    const value =
      credential === "AXIOM_INGEST_TOKEN"
        ? environment.AXIOM_INGEST_TOKEN
        : environment.AXIOM_READ_TOKEN;
    yield* decodeCredentialValue(value).pipe(
      Effect.mapError((cause) =>
        releaseCanaryError(
          "OBS_RELEASE_CANARY_CREDENTIALS_MISSING",
          `Release canary credential ${credential} is missing. Configure the scoped secret in the publication environment and retry.`,
          correlationId,
          cause,
        ),
      ),
    );
  },
);

type ReleaseCanaryOutput = {
  readonly kind: "environment" | "output";
  readonly path: string;
};

type ReleaseCanaryCommand =
  | {
      readonly kind: "credential";
      readonly credential: string;
      readonly correlationId: string;
    }
  | {
      readonly kind: "identity";
      readonly releaseTag: string;
      readonly outputs: ReadonlyArray<ReleaseCanaryOutput>;
      readonly correlationId: string;
    };

const argumentValue = (arguments_: ReadonlyArray<string>, name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
};

const parseCommand = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<ReleaseCanaryCommand, ReleaseCanaryError> =>
  Effect.gen(function* () {
    const correlationId = crypto.randomUUID();
    const credential = argumentValue(arguments_, "--require-credential");
    if (credential !== undefined) {
      return { kind: "credential", credential, correlationId };
    }
    const releaseTag = argumentValue(arguments_, "--tag");
    const githubEnvironment = argumentValue(arguments_, "--github-env");
    const githubOutput = argumentValue(arguments_, "--github-output");
    if (
      releaseTag === undefined ||
      (githubEnvironment === undefined && githubOutput === undefined)
    ) {
      return yield* releaseCanaryError(
        "OBS_RELEASE_CANARY_ARGUMENTS_INVALID",
        "Use --require-credential <name>, or use --tag <tag> with --github-env <path> or --github-output <path>.",
        correlationId,
        arguments_,
      );
    }
    const outputs: Array<ReleaseCanaryOutput> = [];
    if (githubEnvironment !== undefined) {
      outputs.push({ kind: "environment", path: githubEnvironment });
    }
    if (githubOutput !== undefined) outputs.push({ kind: "output", path: githubOutput });
    return { kind: "identity", releaseTag, outputs, correlationId };
  });

const environmentOutput = (identity: ReleaseCanaryIdentity): string =>
  `RELEASE_TAG=${identity.releaseTag}\nRELEASE_PACKAGE_NAME=${identity.packageName}\nRELEASE_PACKAGE_VERSION=${identity.packageVersion}\nOTEL_SERVICE_VERSION=${identity.otelServiceVersion}\n`;

const workflowOutput = (identity: ReleaseCanaryIdentity): string => {
  const prereleaseSeparator = identity.packageVersion.indexOf("-");
  const prerelease = prereleaseSeparator >= 0;
  const prereleaseSuffix = prerelease
    ? identity.packageVersion.slice(prereleaseSeparator + 1).split(".")[0]
    : undefined;
  return `tag=${identity.releaseTag}\narchive=equipe-tech-${identity.packageSlug}-${identity.packageVersion}.tgz\nprerelease=${String(prerelease)}\nnpm_tag=${prereleaseSuffix ?? "latest"}\n`;
};

const writeOutput = Effect.fn("releaseCanary.writeOutput")(function* (
  output: ReleaseCanaryOutput,
  identity: ReleaseCanaryIdentity,
  correlationId: string,
) {
  const content =
    output.kind === "environment" ? environmentOutput(identity) : workflowOutput(identity);
  yield* Effect.tryPromise({
    try: () => appendFile(output.path, content),
    catch: (cause) =>
      releaseCanaryError(
        "OBS_RELEASE_CANARY_OUTPUT_FAILED",
        "The release canary output could not be written.",
        correlationId,
        cause,
      ),
  });
});

const run = Effect.fn("releaseCanary.run")(function* () {
  const command = yield* parseCommand(process.argv.slice(2));
  if (command.kind === "credential") {
    return yield* requireReleaseCanaryCredential(
      process.env,
      command.credential,
      command.correlationId,
    );
  }
  const identity = yield* resolveReleaseCanaryIdentity(
    process.cwd(),
    command.releaseTag,
    command.correlationId,
  );
  for (const output of command.outputs) {
    yield* writeOutput(output, identity, command.correlationId);
  }
  yield* Effect.logInfo(
    `Release canary identity: tag=${identity.releaseTag} package=${identity.packageName} version=${identity.packageVersion} OTEL_SERVICE_VERSION=${identity.otelServiceVersion}`,
  );
});

if (import.meta.main) {
  Effect.runPromise(run()).catch((cause) => {
    const error =
      cause instanceof ReleaseCanaryError
        ? cause
        : releaseCanaryError(
            "OBS_RELEASE_CANARY_UNEXPECTED",
            "The release canary command failed unexpectedly.",
            crypto.randomUUID(),
            cause,
          );
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  });
}
