import { Clock, Context, Effect, Fiber, FileSystem, Layer, Option, Path, Schema } from "effect";
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

export class AxiomEnvironment extends Schema.Class<AxiomEnvironment>(
  "@equipe-tech/observability-cli/AxiomEnvironment",
)({
  tokenId: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
}) {}

export class SentryEnvironment extends Schema.Class<SentryEnvironment>(
  "@equipe-tech/observability-cli/SentryEnvironment",
)({
  project: Schema.NonEmptyString,
  dsn: Schema.NonEmptyString,
}) {}

const AxiomProviders = Schema.Struct({
  type: Schema.Literal("axiom"),
  axiom: AxiomEnvironment,
});
const SentryProviders = Schema.Struct({
  type: Schema.Literal("sentry"),
  sentry: SentryEnvironment,
});
const CombinedProviders = Schema.Struct({
  type: Schema.Literal("combined"),
  axiom: AxiomEnvironment,
  sentry: SentryEnvironment,
});

export const EnvironmentProviders = Schema.Union([
  AxiomProviders,
  SentryProviders,
  CombinedProviders,
]);
export type EnvironmentProviders = typeof EnvironmentProviders.Type;

export class ManagedEnvironment extends Schema.Class<ManagedEnvironment>(
  "@equipe-tech/observability-cli/ManagedEnvironment",
)({
  project: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  providers: EnvironmentProviders,
}) {}

export class CredentialsFile extends Schema.Class<CredentialsFile>(
  "@equipe-tech/observability-cli/CredentialsFile",
)({
  version: Schema.Literal(2),
  axiom: AxiomCredentials.pipe(Schema.optionalKey),
  sentry: SentryCredentials.pipe(Schema.optionalKey),
  environments: Schema.Array(ManagedEnvironment),
}) {}

const LegacyManagedEnvironment = Schema.Struct({
  project: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  axiomTokenId: Schema.NonEmptyString,
  axiomToken: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
  sentryProject: Schema.NonEmptyString,
  sentryDsn: Schema.NonEmptyString,
});

const LegacyCredentialsFile = Schema.Struct({
  version: Schema.Literal(1),
  axiom: AxiomCredentials.pipe(Schema.optionalKey),
  sentry: SentryCredentials.pipe(Schema.optionalKey),
  environments: Schema.Array(LegacyManagedEnvironment),
});

type LegacyCredentialsFile = typeof LegacyCredentialsFile.Type;

const CredentialsVersion = Schema.Struct({ version: Schema.Number });
const decodeCredentialsVersion = Schema.decodeUnknownEffect(CredentialsVersion);
const decodeLegacyCredentialsFile = Schema.decodeUnknownEffect(LegacyCredentialsFile);
const decodeCredentialsFile = Schema.decodeUnknownEffect(CredentialsFile);

const LockOwner = Schema.Struct({
  nonce: Schema.NonEmptyString,
  pid: Schema.Int,
  heartbeat: Schema.Number,
});

const decodeLockOwner = Schema.decodeUnknownEffect(LockOwner);

type PersistedCredentials =
  | { readonly type: "legacy"; readonly credentials: LegacyCredentialsFile }
  | { readonly type: "current"; readonly credentials: CredentialsFile };

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("CredentialsError", {
  code: Schema.Literals([
    "OBS_CLI_CREDENTIALS_INVALID",
    "OBS_CLI_CREDENTIALS_INSECURE",
    "OBS_CLI_CREDENTIALS_FAILED",
    "OBS_CLI_CREDENTIALS_VERSION_UNSUPPORTED",
    "OBS_CLI_CREDENTIALS_BUSY",
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

const invalidCredentials = (cause: unknown): CredentialsError =>
  new CredentialsError({
    code: "OBS_CLI_CREDENTIALS_INVALID",
    message:
      "The credentials file is invalid. Restore a valid credentials file or run the authentication commands again.",
    cause,
  });

const parseCredentials = Effect.fn("parseCredentials")(function* (
  content: string,
): Effect.fn.Return<PersistedCredentials, CredentialsError> {
  const value = yield* Effect.try({
    try: () => JSON.parse(content),
    catch: invalidCredentials,
  });
  const version = yield* decodeCredentialsVersion(value).pipe(Effect.mapError(invalidCredentials));
  if (version.version > 2) {
    return yield* new CredentialsError({
      code: "OBS_CLI_CREDENTIALS_VERSION_UNSUPPORTED",
      message: "The credentials file was written by a newer CLI. Update the CLI and retry.",
      cause: version.version,
    });
  }
  if (version.version === 1) {
    const credentials = yield* decodeLegacyCredentialsFile(value).pipe(
      Effect.mapError(invalidCredentials),
    );
    return { type: "legacy", credentials };
  }
  if (version.version === 2) {
    const credentials = yield* decodeCredentialsFile(value).pipe(
      Effect.mapError(invalidCredentials),
    );
    return { type: "current", credentials };
  }
  return yield* invalidCredentials(version.version);
});

const migrateCredentials = (legacy: LegacyCredentialsFile): CredentialsFile => {
  const environments = legacy.environments.map(
    (environment) =>
      new ManagedEnvironment({
        project: environment.project,
        environment: environment.environment,
        providers: {
          type: "combined",
          axiom: new AxiomEnvironment({
            tokenId: environment.axiomTokenId,
            token: environment.axiomToken,
            tracesDataset: environment.tracesDataset,
            logsDataset: environment.logsDataset,
            metricsDataset: environment.metricsDataset,
          }),
          sentry: new SentryEnvironment({
            project: environment.sentryProject,
            dsn: environment.sentryDsn,
          }),
        },
      }),
  );
  if (legacy.axiom !== undefined && legacy.sentry !== undefined) {
    return new CredentialsFile({
      version: 2,
      axiom: legacy.axiom,
      sentry: legacy.sentry,
      environments,
    });
  }
  if (legacy.axiom !== undefined) {
    return new CredentialsFile({ version: 2, axiom: legacy.axiom, environments });
  }
  if (legacy.sentry !== undefined) {
    return new CredentialsFile({ version: 2, sentry: legacy.sentry, environments });
  }
  return new CredentialsFile({ version: 2, environments });
};

export type CredentialsAccess = {
  load(): Effect.Effect<Option.Option<CredentialsFile>, CredentialsError>;
  save(credentials: CredentialsFile): Effect.Effect<void, CredentialsError>;
};

type ExclusiveCredentials = <A, E, R>(
  use: (access: CredentialsAccess) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CredentialsError, R>;

export class CredentialsStore extends Context.Service<
  CredentialsStore,
  {
    load(): Effect.Effect<Option.Option<CredentialsFile>, CredentialsError>;
    save(credentials: CredentialsFile): Effect.Effect<void, CredentialsError>;
    exclusive: ExclusiveCredentials;
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
      const lockPath = path.join(root, ".credentials.lock");
      const lockOwnerPath = path.join(lockPath, "owner.json");

      const prepareRoot = Effect.fn("CredentialsStore.prepareRoot")(function* () {
        yield* fs
          .makeDirectory(root, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(credentialsFailure));
        yield* fs.chmod(root, 0o700).pipe(Effect.mapError(credentialsFailure));
      });

      const writeLockOwner = Effect.fn("CredentialsStore.writeLockOwner")(function* (
        nonce: string,
      ) {
        const heartbeat = yield* Clock.currentTimeMillis;
        const temporaryPath = path.join(lockPath, `owner-${nonce}-${crypto.randomUUID()}.tmp`);
        const content = `${JSON.stringify({ nonce, pid: process.pid, heartbeat })}\n`;
        yield* fs
          .writeFileString(temporaryPath, content, { mode: 0o600 })
          .pipe(Effect.mapError(credentialsFailure));
        yield* fs.chmod(temporaryPath, 0o600).pipe(Effect.mapError(credentialsFailure));
        yield* fs.rename(temporaryPath, lockOwnerPath).pipe(Effect.mapError(credentialsFailure));
      });

      const lockAge = Effect.fn("CredentialsStore.lockAge")(function* () {
        const now = yield* Clock.currentTimeMillis;
        const content = yield* fs.readFileString(lockOwnerPath).pipe(Effect.option);
        if (Option.isSome(content)) {
          const parsed = yield* Effect.try((): unknown => JSON.parse(content.value)).pipe(
            Effect.flatMap(decodeLockOwner),
            Effect.option,
          );
          if (Option.isSome(parsed)) {
            return now - parsed.value.heartbeat;
          }
        }
        const info = yield* fs.stat(lockPath).pipe(Effect.option);
        if (Option.isSome(info) && Option.isSome(info.value.mtime)) {
          return now - info.value.mtime.value.getTime();
        }
        return 0;
      });

      const reclaimStaleLock = Effect.fn("CredentialsStore.reclaimStaleLock")(function* () {
        const age = yield* lockAge();
        if (age <= 30_000) {
          return false;
        }
        const tombstone = `${lockPath}.stale-${crypto.randomUUID()}`;
        const renamed = yield* fs.rename(lockPath, tombstone).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!renamed) {
          return false;
        }
        yield* fs
          .remove(tombstone, { recursive: true, force: true })
          .pipe(Effect.mapError(credentialsFailure));
        return true;
      });

      const acquireLock = Effect.fn("CredentialsStore.acquireLock")(function* () {
        yield* prepareRoot();
        const nonce = crypto.randomUUID();
        const started = yield* Clock.currentTimeMillis;
        while (true) {
          const acquired = yield* fs.makeDirectory(lockPath, { mode: 0o700 }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (acquired) {
            return yield* writeLockOwner(nonce).pipe(
              Effect.as(nonce),
              Effect.catch((error) =>
                fs
                  .remove(lockPath, { recursive: true, force: true })
                  .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
              ),
            );
          }
          yield* reclaimStaleLock();
          const now = yield* Clock.currentTimeMillis;
          if (now - started >= 30_000) {
            return yield* new CredentialsError({
              code: "OBS_CLI_CREDENTIALS_BUSY",
              message:
                "Another observability command is updating credentials. Retry after it finishes.",
              cause: "credentials-lock-timeout",
            });
          }
          yield* Effect.sleep("100 millis");
        }
      });

      const heartbeat = Effect.fn("CredentialsStore.heartbeat")(function* (nonce: string) {
        while (true) {
          yield* Effect.sleep("1 second");
          yield* writeLockOwner(nonce);
        }
      });

      const releaseLock = Effect.fn("CredentialsStore.releaseLock")(function* (nonce: string) {
        const content = yield* fs.readFileString(lockOwnerPath).pipe(Effect.option);
        if (Option.isNone(content)) {
          return;
        }
        const owner = yield* Effect.try((): unknown => JSON.parse(content.value)).pipe(
          Effect.flatMap(decodeLockOwner),
          Effect.option,
        );
        if (Option.isSome(owner) && owner.value.nonce === nonce) {
          yield* fs
            .remove(lockPath, { recursive: true, force: true })
            .pipe(Effect.mapError(credentialsFailure));
        }
      });

      const loadPersisted = Effect.fn("CredentialsStore.loadPersisted")(function* () {
        const exists = yield* fs.exists(credentialsPath).pipe(Effect.mapError(credentialsFailure));
        if (!exists) {
          return Option.none<PersistedCredentials>();
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

      const saveUnlocked = Effect.fn("CredentialsStore.saveUnlocked")(function* (
        credentials: CredentialsFile,
      ) {
        yield* prepareRoot();
        const temporaryPath = `${credentialsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const content = new TextEncoder().encode(`${JSON.stringify(credentials, undefined, 2)}\n`);
        const write = Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs
              .open(temporaryPath, { flag: "wx", mode: 0o600 })
              .pipe(Effect.mapError(credentialsFailure));
            yield* file.writeAll(content).pipe(Effect.mapError(credentialsFailure));
            yield* file.sync.pipe(Effect.mapError(credentialsFailure));
          }),
        );
        yield* Effect.gen(function* () {
          yield* write;
          yield* fs.chmod(temporaryPath, 0o600).pipe(Effect.mapError(credentialsFailure));
          yield* fs
            .rename(temporaryPath, credentialsPath)
            .pipe(Effect.mapError(credentialsFailure));
          yield* fs.chmod(credentialsPath, 0o600).pipe(Effect.mapError(credentialsFailure));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fs
                .open(root, { flag: "r" })
                .pipe(Effect.mapError(credentialsFailure));
              yield* directory.sync.pipe(Effect.mapError(credentialsFailure));
            }),
          );
          const info = yield* fs.stat(credentialsPath).pipe(Effect.mapError(credentialsFailure));
          if ((info.mode & 0o777) !== 0o600) {
            return yield* credentialsFailure(info.mode);
          }
        }).pipe(Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)));
      });

      const loadCurrentUnlocked = Effect.fn("CredentialsStore.loadCurrentUnlocked")(function* () {
        const persisted = yield* loadPersisted();
        if (Option.isNone(persisted)) {
          return Option.none<CredentialsFile>();
        }
        if (persisted.value.type === "current") {
          return Option.some(persisted.value.credentials);
        }
        const migrated = migrateCredentials(persisted.value.credentials);
        yield* saveUnlocked(migrated);
        return Option.some(migrated);
      });

      const access: CredentialsAccess = {
        load: loadCurrentUnlocked,
        save: saveUnlocked,
      };

      const exclusive: ExclusiveCredentials = (use) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const nonce = yield* acquireLock();
            const fiber = yield* heartbeat(nonce).pipe(Effect.forkChild);
            return { nonce, fiber };
          }),
          () => use(access),
          ({ fiber, nonce }) => Fiber.interrupt(fiber).pipe(Effect.andThen(releaseLock(nonce))),
        );

      const load = Effect.fn("CredentialsStore.load")(function* () {
        const persisted = yield* loadPersisted();
        if (Option.isNone(persisted)) {
          return Option.none<CredentialsFile>();
        }
        if (persisted.value.type === "current") {
          return Option.some(persisted.value.credentials);
        }
        return yield* exclusive((locked) => locked.load());
      });

      const save = (credentials: CredentialsFile): Effect.Effect<void, CredentialsError> =>
        exclusive((locked) => locked.save(credentials));

      return CredentialsStore.of({ load, save, exclusive, path: credentialsPath });
    }),
  );
}

export const emptyCredentials = (): CredentialsFile =>
  new CredentialsFile({ version: 2, environments: [] });
