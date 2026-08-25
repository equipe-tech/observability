import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { homedir } from "node:os";

const CredentialsEnvironment = Schema.Struct({
  OBSERVABILITY_HOME: Schema.NonEmptyString.pipe(Schema.optionalKey),
});

const decodeCredentialsEnvironment = Schema.decodeUnknownEffect(CredentialsEnvironment);

export class AxiomCredentials extends Schema.Class<AxiomCredentials>(
  "@equipe-tech/observability-cli/AxiomCredentials",
)({
  token: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
}) {}

export class SentryCredentials extends Schema.Class<SentryCredentials>(
  "@equipe-tech/observability-cli/SentryCredentials",
)({
  token: Schema.NonEmptyString,
  organization: Schema.NonEmptyString,
  team: Schema.NonEmptyString,
  baseUrl: Schema.URLFromString,
}) {}

export class ManagedEnvironment extends Schema.Class<ManagedEnvironment>(
  "@equipe-tech/observability-cli/ManagedEnvironment",
)({
  project: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  axiomTokenId: Schema.NonEmptyString,
  axiomToken: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
  sentryProject: Schema.NonEmptyString,
  sentryDsn: Schema.NonEmptyString,
}) {}

export class CredentialsFile extends Schema.Class<CredentialsFile>(
  "@equipe-tech/observability-cli/CredentialsFile",
)({
  version: Schema.Literal(1),
  axiom: AxiomCredentials.pipe(Schema.optionalKey),
  sentry: SentryCredentials.pipe(Schema.optionalKey),
  environments: Schema.Array(ManagedEnvironment),
}) {}

const decodeCredentialsFile = Schema.decodeUnknownEffect(CredentialsFile);

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("CredentialsError", {
  code: Schema.Literals([
    "OBS_CLI_CREDENTIALS_INVALID",
    "OBS_CLI_CREDENTIALS_INSECURE",
    "OBS_CLI_CREDENTIALS_FAILED",
  ]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const credentialsFailure = (cause: unknown): CredentialsError =>
  new CredentialsError({
    code: "OBS_CLI_CREDENTIALS_FAILED",
    message:
      "The credentials file could not be accessed. Check OBSERVABILITY_HOME permissions and retry.",
    cause,
  });

const parseCredentials = Effect.fn("parseCredentials")(function* (content: string) {
  const value = yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) =>
      new CredentialsError({
        code: "OBS_CLI_CREDENTIALS_INVALID",
        message:
          "The credentials file is invalid. Remove it and run the authentication commands again.",
        cause,
      }),
  });
  return yield* decodeCredentialsFile(value).pipe(
    Effect.mapError(
      (cause) =>
        new CredentialsError({
          code: "OBS_CLI_CREDENTIALS_INVALID",
          message:
            "The credentials file is invalid. Remove it and run the authentication commands again.",
          cause,
        }),
    ),
  );
});

export class CredentialsStore extends Context.Service<
  CredentialsStore,
  {
    load(): Effect.Effect<Option.Option<CredentialsFile>, CredentialsError>;
    save(credentials: CredentialsFile): Effect.Effect<void, CredentialsError>;
    path: string;
  }
>()("@equipe-tech/observability-cli/CredentialsStore") {
  static readonly layer = Layer.effect(
    CredentialsStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const environment = yield* decodeCredentialsEnvironment(process.env).pipe(
        Effect.mapError(
          (cause) =>
            new CredentialsError({
              code: "OBS_CLI_CREDENTIALS_INVALID",
              message: "OBSERVABILITY_HOME must contain a non-empty path.",
              cause,
            }),
        ),
      );
      const root =
        environment.OBSERVABILITY_HOME ?? path.join(homedir(), ".local", "state", "observability");
      const credentialsPath = path.join(root, "credentials.json");

      const load = Effect.fn("CredentialsStore.load")(function* () {
        const exists = yield* fs.exists(credentialsPath).pipe(Effect.mapError(credentialsFailure));
        if (!exists) {
          return Option.none();
        }
        const info = yield* fs.stat(credentialsPath).pipe(Effect.mapError(credentialsFailure));
        if ((info.mode & 0o077) !== 0) {
          return yield* new CredentialsError({
            code: "OBS_CLI_CREDENTIALS_INSECURE",
            message:
              "The credentials file is accessible by other users. Run chmod 600 on the file and retry.",
            cause: info.mode,
          });
        }
        const content = yield* fs
          .readFileString(credentialsPath)
          .pipe(Effect.mapError(credentialsFailure));
        return Option.some(yield* parseCredentials(content));
      });

      const save = Effect.fn("CredentialsStore.save")(function* (credentials: CredentialsFile) {
        yield* fs
          .makeDirectory(root, { recursive: true })
          .pipe(Effect.mapError(credentialsFailure));
        yield* fs.chmod(root, 0o700).pipe(Effect.mapError(credentialsFailure));
        const temporaryPath = `${credentialsPath}.tmp`;
        const content = `${JSON.stringify(credentials, undefined, 2)}\n`;
        yield* fs
          .writeFileString(temporaryPath, content, { mode: 0o600 })
          .pipe(Effect.mapError(credentialsFailure));
        yield* fs.chmod(temporaryPath, 0o600).pipe(Effect.mapError(credentialsFailure));
        yield* fs.rename(temporaryPath, credentialsPath).pipe(Effect.mapError(credentialsFailure));
      });

      return CredentialsStore.of({ load, save, path: credentialsPath });
    }),
  );
}

export const emptyCredentials = (): CredentialsFile =>
  new CredentialsFile({ version: 1, environments: [] });
