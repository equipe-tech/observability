import { Effect, Schema } from "effect";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const ReleaseTag = Schema.String.check(
  Schema.isPattern(/^[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/),
);

export class ReleaseCanaryIdentity extends Schema.Class<ReleaseCanaryIdentity>(
  "@equipe-tech/observability/ReleaseCanaryIdentity",
)({
  releaseTag: ReleaseTag,
  packageName: Schema.NonEmptyString,
  packageVersion: Schema.NonEmptyString,
  otelServiceVersion: Schema.NonEmptyString,
}) {}

export class ReleaseCanaryCredentials extends Schema.Class<ReleaseCanaryCredentials>(
  "@equipe-tech/observability/ReleaseCanaryCredentials",
)({
  axiomIngestSecret: Schema.NonEmptyString,
  axiomReadSecret: Schema.NonEmptyString,
}) {}

export class ReleaseCanaryConfigurationError extends Schema.TaggedError<ReleaseCanaryConfigurationError>()(
  "ReleaseCanaryConfigurationError",
  {
    code: Schema.Literal("OBS_RELEASE_CANARY_CREDENTIALS_MISSING"),
    message: Schema.String,
    missingCredentials: Schema.Array(Schema.NonEmptyString),
    cause: Schema.Defect(),
  },
) {}

const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

const ReleaseCanaryEnvironment = Schema.Struct({
  AXIOM_INGEST_TOKEN: Schema.NonEmptyString,
  AXIOM_READ_TOKEN: Schema.NonEmptyString,
});

const decodeReleaseTag = Schema.decodeUnknownEffect(ReleaseTag);
const decodePackageManifest = Schema.decodeUnknownEffect(PackageManifest);
const decodeReleaseCanaryEnvironment = Schema.decodeUnknownEffect(ReleaseCanaryEnvironment);

export const resolveReleaseCanaryIdentity = Effect.fn("resolveReleaseCanaryIdentity")(function* (
  root: string,
  releaseTag: string,
) {
  const tag = yield* decodeReleaseTag(releaseTag);
  const slug = tag.slice(0, tag.lastIndexOf("@"));
  const packageVersion = tag.slice(tag.lastIndexOf("@") + 1);
  const packageDirectories = yield* Effect.promise(() =>
    Array.fromAsync(new Bun.Glob("packages/*/package.json").scan(root)),
  );
  for (const relativePath of packageDirectories) {
    const manifestValue = yield* Effect.promise(() => Bun.file(join(root, relativePath)).json());
    const manifest = yield* decodePackageManifest(manifestValue);
    if (manifest.name.replace(/^@equipe-tech\//, "") !== slug) continue;
    if (manifest.version !== packageVersion) {
      return yield* Effect.fail(
        new Error(`The release tag ${tag} does not match ${relativePath} (${manifest.version}).`),
      );
    }
    return new ReleaseCanaryIdentity({
      releaseTag: tag,
      packageName: manifest.name,
      packageVersion,
      otelServiceVersion: packageVersion,
    });
  }
  return yield* Effect.fail(new Error(`The release tag ${tag} selects an unknown package.`));
});

export const resolveReleaseCanaryCredentials = Effect.fn("resolveReleaseCanaryCredentials")(
  function* (environment: NodeJS.ProcessEnv) {
    return yield* decodeReleaseCanaryEnvironment(environment).pipe(
      Effect.map(
        (credentials) =>
          new ReleaseCanaryCredentials({
            axiomIngestSecret: credentials.AXIOM_INGEST_TOKEN,
            axiomReadSecret: credentials.AXIOM_READ_TOKEN,
          }),
      ),
      Effect.mapError((cause) => {
        const missingCredentials = [
          environment.AXIOM_INGEST_TOKEN ? undefined : "AXIOM_INGEST_TOKEN",
          environment.AXIOM_READ_TOKEN ? undefined : "AXIOM_READ_TOKEN",
        ].filter((name): name is string => name !== undefined);
        return new ReleaseCanaryConfigurationError({
          code: "OBS_RELEASE_CANARY_CREDENTIALS_MISSING",
          message: `Release canary credentials are missing: ${missingCredentials.join(", ")}. Configure both scoped secrets in the publication environment and retry.`,
          missingCredentials,
          cause,
        });
      }),
    );
  },
);

const run = Effect.fn("releaseCanary.run")(function* () {
  const tagIndex = process.argv.indexOf("--tag");
  const githubEnvironmentIndex = process.argv.indexOf("--github-env");
  const releaseTag = process.argv[tagIndex + 1];
  const githubEnvironment = process.argv[githubEnvironmentIndex + 1];
  if (
    tagIndex < 0 ||
    releaseTag === undefined ||
    githubEnvironmentIndex < 0 ||
    githubEnvironment === undefined
  ) {
    return yield* Effect.fail(
      new Error("Usage: bun scripts/release-canary.ts --tag <tag> --github-env <path>"),
    );
  }
  const identity = yield* resolveReleaseCanaryIdentity(process.cwd(), releaseTag);
  yield* resolveReleaseCanaryCredentials(process.env);
  yield* Effect.promise(() =>
    appendFile(
      githubEnvironment,
      `RELEASE_TAG=${identity.releaseTag}\nRELEASE_PACKAGE_NAME=${identity.packageName}\nRELEASE_PACKAGE_VERSION=${identity.packageVersion}\nOTEL_SERVICE_VERSION=${identity.otelServiceVersion}\n`,
    ),
  );
  yield* Effect.logInfo(
    `Release canary identity: tag=${identity.releaseTag} package=${identity.packageName} version=${identity.packageVersion} OTEL_SERVICE_VERSION=${identity.otelServiceVersion}`,
  );
});

if (import.meta.main) {
  Effect.runPromise(run()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
