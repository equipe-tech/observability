import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
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

export const AxiomDatasetKind = Schema.Literals([
  "axiom:events:v1",
  "otel:logs:v1",
  "otel:metrics:v1",
  "otel:traces:v1",
]);

export class VerifiedAxiomDataset extends Schema.Class<VerifiedAxiomDataset>(
  "@equipe-tech/observability-cli/VerifiedAxiomDataset",
)({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  kind: AxiomDatasetKind,
  edgeDeployment: Schema.NonEmptyString.pipe(Schema.optionalKey),
  retentionDays: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optionalKey),
  useRetentionPeriod: Schema.Boolean,
}) {}

const VerificationRequired = Schema.Struct({ type: Schema.Literal("verification-required") });
const ManualCorrelation = Schema.Struct({
  type: Schema.Literal("manual-required"),
  groupName: Schema.NonEmptyString,
  groupSlug: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
});
const ConfirmedCorrelation = Schema.Struct({
  type: Schema.Literal("operator-confirmed"),
  groupName: Schema.NonEmptyString,
  groupSlug: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
  confirmedAt: Schema.NonEmptyString,
});
export const AxiomCorrelationState = Schema.Union([
  VerificationRequired,
  ManualCorrelation,
  ConfirmedCorrelation,
]);
export type AxiomCorrelationState = typeof AxiomCorrelationState.Type;

const VerifiedAxiomDatasets = Schema.Struct({
  traces: VerifiedAxiomDataset,
  logs: VerifiedAxiomDataset,
  metrics: VerifiedAxiomDataset,
});
export type VerifiedAxiomDatasets = typeof VerifiedAxiomDatasets.Type;

export class AxiomEnvironment extends Schema.Class<AxiomEnvironment>(
  "@equipe-tech/observability-cli/AxiomEnvironment",
)({
  tokenId: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
  datasets: VerifiedAxiomDatasets.pipe(Schema.optionalKey),
  correlation: AxiomCorrelationState,
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

export class PendingAxiomMutation extends Schema.Class<PendingAxiomMutation>(
  "@equipe-tech/observability-cli/PendingAxiomMutation",
)({
  project: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
}) {}

export class CredentialsFile extends Schema.Class<CredentialsFile>(
  "@equipe-tech/observability-cli/CredentialsFile",
)({
  version: Schema.Literal(3),
  axiom: AxiomCredentials.pipe(Schema.optionalKey),
  sentry: SentryCredentials.pipe(Schema.optionalKey),
  environments: Schema.Array(ManagedEnvironment),
  pendingAxiomMutations: Schema.Array(PendingAxiomMutation).pipe(Schema.optionalKey),
}) {}

const Version2AxiomEnvironment = Schema.Struct({
  tokenId: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  tracesDataset: Schema.NonEmptyString,
  logsDataset: Schema.NonEmptyString,
  metricsDataset: Schema.NonEmptyString,
});
const Version2AxiomProviders = Schema.Struct({
  type: Schema.Literal("axiom"),
  axiom: Version2AxiomEnvironment,
});
const Version2SentryProviders = Schema.Struct({
  type: Schema.Literal("sentry"),
  sentry: SentryEnvironment,
});
const Version2CombinedProviders = Schema.Struct({
  type: Schema.Literal("combined"),
  axiom: Version2AxiomEnvironment,
  sentry: SentryEnvironment,
});
const Version2ManagedEnvironment = Schema.Struct({
  project: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  providers: Schema.Union([
    Version2AxiomProviders,
    Version2SentryProviders,
    Version2CombinedProviders,
  ]),
});
const Version2CredentialsFile = Schema.Struct({
  version: Schema.Literal(2),
  axiom: AxiomCredentials.pipe(Schema.optionalKey),
  sentry: SentryCredentials.pipe(Schema.optionalKey),
  environments: Schema.Array(Version2ManagedEnvironment),
  pendingAxiomMutations: Schema.Array(PendingAxiomMutation).pipe(Schema.optionalKey),
});
type Version2CredentialsFile = typeof Version2CredentialsFile.Type;

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
const decodeVersion2CredentialsFile = Schema.decodeUnknownEffect(Version2CredentialsFile);
const decodeCredentialsFile = Schema.decodeUnknownEffect(CredentialsFile);

const LockOwner = Schema.Struct({
  nonce: Schema.NonEmptyString,
  pid: Schema.Int,
  heartbeat: Schema.Number,
});

const decodeLockOwner = Schema.decodeUnknownEffect(LockOwner);

type PersistedCredentials =
  | { readonly type: "version-1"; readonly credentials: LegacyCredentialsFile }
  | { readonly type: "version-2"; readonly credentials: Version2CredentialsFile }
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
  if (version.version > 3) {
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
    return { type: "version-1", credentials };
  }
  if (version.version === 2) {
    const credentials = yield* decodeVersion2CredentialsFile(value).pipe(
      Effect.mapError(invalidCredentials),
    );
    return { type: "version-2", credentials };
  }
  if (version.version === 3) {
    const credentials = yield* decodeCredentialsFile(value).pipe(
      Effect.mapError(invalidCredentials),
    );
    return { type: "current", credentials };
  }
  return yield* invalidCredentials(version.version);
});

const unverifiedAxiomEnvironment = (environment: {
  readonly tokenId: string;
  readonly token: string;
  readonly tracesDataset: string;
  readonly logsDataset: string;
  readonly metricsDataset: string;
}): AxiomEnvironment =>
  new AxiomEnvironment({
    tokenId: environment.tokenId,
    token: environment.token,
    tracesDataset: environment.tracesDataset,
    logsDataset: environment.logsDataset,
    metricsDataset: environment.metricsDataset,
    correlation: { type: "verification-required" },
  });

const makeMigratedCredentials = (
  axiom: AxiomCredentials | undefined,
  sentry: SentryCredentials | undefined,
  environments: ReadonlyArray<ManagedEnvironment>,
  pendingAxiomMutations: ReadonlyArray<PendingAxiomMutation> = [],
): CredentialsFile => {
  const pending = pendingAxiomMutations.length === 0 ? undefined : pendingAxiomMutations;
  if (axiom !== undefined && sentry !== undefined) {
    return pending === undefined
      ? new CredentialsFile({ version: 3, environments, axiom, sentry })
      : new CredentialsFile({
          version: 3,
          environments,
          axiom,
          sentry,
          pendingAxiomMutations: pending,
        });
  }
  if (axiom !== undefined) {
    return pending === undefined
      ? new CredentialsFile({ version: 3, environments, axiom })
      : new CredentialsFile({
          version: 3,
          environments,
          axiom,
          pendingAxiomMutations: pending,
        });
  }
  if (sentry !== undefined) {
    return pending === undefined
      ? new CredentialsFile({ version: 3, environments, sentry })
      : new CredentialsFile({
          version: 3,
          environments,
          sentry,
          pendingAxiomMutations: pending,
        });
  }
  return pending === undefined
    ? new CredentialsFile({ version: 3, environments })
    : new CredentialsFile({ version: 3, environments, pendingAxiomMutations: pending });
};

const migrateVersion1Credentials = (legacy: LegacyCredentialsFile): CredentialsFile => {
  const environments = legacy.environments.map(
    (environment) =>
      new ManagedEnvironment({
        project: environment.project,
        environment: environment.environment,
        providers: {
          type: "combined",
          axiom: unverifiedAxiomEnvironment({
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
  return makeMigratedCredentials(legacy.axiom, legacy.sentry, environments);
};

const migrateVersion2Credentials = (legacy: Version2CredentialsFile): CredentialsFile => {
  const environments = legacy.environments.map((environment) => {
    if (environment.providers.type === "sentry") {
      return new ManagedEnvironment({
        project: environment.project,
        environment: environment.environment,
        providers: environment.providers,
      });
    }
    const axiom = unverifiedAxiomEnvironment(environment.providers.axiom);
    if (environment.providers.type === "axiom") {
      return new ManagedEnvironment({
        project: environment.project,
        environment: environment.environment,
        providers: { type: "axiom", axiom },
      });
    }
    return new ManagedEnvironment({
      project: environment.project,
      environment: environment.environment,
      providers: { type: "combined", axiom, sentry: environment.providers.sentry },
    });
  });
  return makeMigratedCredentials(
    legacy.axiom,
    legacy.sentry,
    environments,
    legacy.pendingAxiomMutations ?? [],
  );
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
      const heartbeatPath = (nonce: string): string =>
        path.join(root, `.credentials.heartbeat-${nonce}`);

      const prepareRoot = Effect.fn("CredentialsStore.prepareRoot")(function* () {
        yield* fs
          .makeDirectory(root, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(credentialsFailure));
        yield* fs.chmod(root, 0o700).pipe(Effect.mapError(credentialsFailure));
      });

      const writeLockOwner = Effect.fn("CredentialsStore.writeLockOwner")(function* (
        directory: string,
        nonce: string,
      ) {
        const heartbeat = yield* Clock.currentTimeMillis;
        const ownerPath = path.join(directory, "owner.json");
        const content = `${JSON.stringify({ nonce, pid: process.pid, heartbeat })}\n`;
        yield* fs
          .writeFileString(ownerPath, content, { mode: 0o600 })
          .pipe(Effect.mapError(credentialsFailure));
        yield* fs.chmod(ownerPath, 0o600).pipe(Effect.mapError(credentialsFailure));
      });

      const writeHeartbeat = Effect.fn("CredentialsStore.writeHeartbeat")(function* (
        nonce: string,
      ) {
        const heartbeat = yield* Clock.currentTimeMillis;
        const target = heartbeatPath(nonce);
        const temporaryPath = `${target}.${crypto.randomUUID()}.tmp`;
        yield* Effect.gen(function* () {
          yield* fs
            .writeFileString(temporaryPath, `${heartbeat}\n`, { mode: 0o600 })
            .pipe(Effect.mapError(credentialsFailure));
          yield* fs.chmod(temporaryPath, 0o600).pipe(Effect.mapError(credentialsFailure));
          yield* fs.rename(temporaryPath, target).pipe(Effect.mapError(credentialsFailure));
        }).pipe(Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)));
      });

      const lockOwner = Effect.fn("CredentialsStore.lockOwner")(function* (ownerPath: string) {
        const content = yield* fs.readFileString(ownerPath).pipe(Effect.option);
        if (Option.isNone(content)) {
          return Option.none<typeof LockOwner.Type>();
        }
        return yield* Effect.try((): unknown => JSON.parse(content.value)).pipe(
          Effect.flatMap(decodeLockOwner),
          Effect.option,
        );
      });

      const assertLockOwnership = Effect.fn("CredentialsStore.assertLockOwnership")(function* (
        nonce: string,
      ) {
        const owner = yield* lockOwner(lockOwnerPath);
        if (Option.isNone(owner) || owner.value.nonce !== nonce) {
          return yield* credentialsFailure("credentials-lock-ownership-lost");
        }
      });

      const lockAge = Effect.fn("CredentialsStore.lockAge")(function* () {
        const now = yield* Clock.currentTimeMillis;
        const owner = yield* lockOwner(lockOwnerPath);
        if (Option.isSome(owner)) {
          const heartbeat = yield* fs.readFileString(heartbeatPath(owner.value.nonce)).pipe(
            Effect.flatMap((value) => Effect.try(() => Number(value.trim()))),
            Effect.option,
          );
          if (Option.isSome(heartbeat) && Number.isFinite(heartbeat.value)) {
            return now - heartbeat.value;
          }
          return now - owner.value.heartbeat;
        }
        const info = yield* fs.stat(lockPath).pipe(Effect.option);
        if (Option.isSome(info) && Option.isSome(info.value.mtime)) {
          return now - info.value.mtime.value.getTime();
        }
        return 0;
      });

      const artifactAge = Effect.fn("CredentialsStore.artifactAge")(function* (
        artifactPath: string,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const info = yield* fs.stat(artifactPath).pipe(Effect.option);
        if (Option.isSome(info) && Option.isSome(info.value.mtime)) {
          return Option.some(now - info.value.mtime.value.getTime());
        }
        return Option.none<number>();
      });

      const cleanupStaleLockArtifacts = Effect.fn("CredentialsStore.cleanupStaleLockArtifacts")(
        function* () {
          const owner = yield* lockOwner(lockOwnerPath);
          const activeNonce = Option.map(owner, (current) => current.nonce);
          const entries = yield* fs.readDirectory(root).pipe(Effect.mapError(credentialsFailure));
          for (const entry of entries) {
            const candidate = entry.startsWith(".credentials.lock.candidate-");
            const heartbeat = entry.startsWith(".credentials.heartbeat-");
            const tombstone =
              entry.startsWith(".credentials.lock.released-") ||
              entry.startsWith(".credentials.lock.stale-");
            if (!candidate && !heartbeat && !tombstone) {
              continue;
            }
            if (heartbeat) {
              const nonce = entry.slice(".credentials.heartbeat-".length);
              if (Option.contains(activeNonce, nonce)) {
                continue;
              }
            }
            const artifactPath = path.join(root, entry);
            const age = yield* artifactAge(artifactPath);
            if (Option.isSome(age) && age.value > 60_000) {
              yield* fs
                .remove(artifactPath, { recursive: candidate || tombstone, force: true })
                .pipe(Effect.mapError(credentialsFailure));
            }
          }
        },
      );

      const reclaimStaleLock = Effect.fn("CredentialsStore.reclaimStaleLock")(function* () {
        const age = yield* lockAge();
        if (age <= 30_000) {
          return false;
        }
        const owner = yield* lockOwner(lockOwnerPath);
        const tombstone = `${lockPath}.stale-${crypto.randomUUID()}`;
        const renamed = yield* fs.rename(lockPath, tombstone).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!renamed) {
          return false;
        }
        const reclaimedOwner = yield* lockOwner(path.join(tombstone, "owner.json"));
        const sameGeneration = Option.match(owner, {
          onNone: () => Option.isNone(reclaimedOwner),
          onSome: (observed) =>
            Option.isSome(reclaimedOwner) && reclaimedOwner.value.nonce === observed.nonce,
        });
        if (!sameGeneration) {
          const restored = yield* fs.rename(tombstone, lockPath).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!restored) {
            return yield* credentialsFailure("credentials-lock-reclaim-generation-changed");
          }
          return false;
        }
        yield* fs
          .remove(tombstone, { recursive: true, force: true })
          .pipe(Effect.mapError(credentialsFailure));
        if (Option.isSome(owner)) {
          yield* fs.remove(heartbeatPath(owner.value.nonce), { force: true }).pipe(Effect.ignore);
        }
        return true;
      });

      const acquireLock = Effect.fn("CredentialsStore.acquireLock")(function* () {
        yield* prepareRoot();
        yield* cleanupStaleLockArtifacts();
        const nonce = crypto.randomUUID();
        const candidatePath = `${lockPath}.candidate-${nonce}`;
        const started = yield* Clock.currentTimeMillis;
        yield* fs
          .makeDirectory(candidatePath, { mode: 0o700 })
          .pipe(Effect.mapError(credentialsFailure));
        yield* writeLockOwner(candidatePath, nonce).pipe(
          Effect.andThen(writeHeartbeat(nonce)),
          Effect.catch((error) =>
            fs
              .remove(candidatePath, { recursive: true, force: true })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  fs.remove(heartbeatPath(nonce), { force: true }).pipe(Effect.ignore),
                ),
                Effect.andThen(Effect.fail(error)),
              ),
          ),
        );
        while (true) {
          const acquired = yield* fs.rename(candidatePath, lockPath).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (acquired) {
            return nonce;
          }
          yield* reclaimStaleLock();
          const now = yield* Clock.currentTimeMillis;
          if (now - started >= 30_000) {
            yield* fs.remove(candidatePath, { recursive: true, force: true }).pipe(Effect.ignore);
            yield* fs.remove(heartbeatPath(nonce), { force: true }).pipe(Effect.ignore);
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
          yield* assertLockOwnership(nonce);
          yield* writeHeartbeat(nonce);
        }
      });

      const releaseLock = Effect.fn("CredentialsStore.releaseLock")(function* (nonce: string) {
        const owner = yield* lockOwner(lockOwnerPath);
        if (Option.isSome(owner) && owner.value.nonce === nonce) {
          const tombstone = `${lockPath}.released-${nonce}-${crypto.randomUUID()}`;
          const renamed = yield* fs.rename(lockPath, tombstone).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (renamed) {
            const releasedOwner = yield* lockOwner(path.join(tombstone, "owner.json"));
            if (Option.isSome(releasedOwner) && releasedOwner.value.nonce === nonce) {
              yield* fs
                .remove(tombstone, { recursive: true, force: true })
                .pipe(Effect.mapError(credentialsFailure));
            } else {
              return yield* credentialsFailure("credentials-lock-generation-changed");
            }
          }
        }
        yield* fs.remove(heartbeatPath(nonce), { force: true }).pipe(Effect.ignore);
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

      const loadCurrentUnlocked = Effect.fn("CredentialsStore.loadCurrentUnlocked")(function* (
        save: CredentialsAccess["save"],
      ) {
        const persisted = yield* loadPersisted();
        if (Option.isNone(persisted)) {
          return Option.none<CredentialsFile>();
        }
        if (persisted.value.type === "current") {
          return Option.some(persisted.value.credentials);
        }
        const migrated =
          persisted.value.type === "version-1"
            ? migrateVersion1Credentials(persisted.value.credentials)
            : migrateVersion2Credentials(persisted.value.credentials);
        yield* save(migrated);
        return Option.some(migrated);
      });

      const exclusive: ExclusiveCredentials = (use) =>
        Effect.acquireUseRelease(
          acquireLock(),
          (nonce) => {
            const save = (credentials: CredentialsFile): Effect.Effect<void, CredentialsError> =>
              assertLockOwnership(nonce).pipe(Effect.andThen(saveUnlocked(credentials)));
            const access: CredentialsAccess = {
              load: () => loadCurrentUnlocked(save),
              save,
            };
            return use(access).pipe(Effect.raceFirst(heartbeat(nonce)));
          },
          releaseLock,
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
  new CredentialsFile({ version: 3, environments: [] });
