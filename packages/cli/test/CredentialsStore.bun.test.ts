import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Option, Schema } from "effect";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AxiomCredentials,
  CredentialsFile,
  CredentialsStore,
  SentryCredentials,
} from "../src/CredentialsStore.ts";

const PersistedVersion = Schema.Struct({ version: Schema.Number });
const PersistedLockOwner = Schema.Struct({
  nonce: Schema.NonEmptyString,
  pid: Schema.Int,
  heartbeat: Schema.Number,
});
const decodePersistedVersion = Schema.decodeUnknownSync(PersistedVersion);
const decodePersistedLockOwner = Schema.decodeUnknownSync(PersistedLockOwner);

const makeAdvancingClock = (): Clock.Clock => {
  let current = 0;
  const nextMillis = (): number => {
    current += 1_000;
    return current;
  };
  const nextNanos = (): bigint => BigInt(nextMillis()) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: nextMillis,
    currentTimeMillis: Effect.sync(nextMillis),
    currentTimeNanosUnsafe: nextNanos,
    currentTimeNanos: Effect.sync(nextNanos),
    monotonicTimeNanosUnsafe: nextNanos,
    monotonicTimeNanos: Effect.sync(nextNanos),
    sleep: () => Effect.void,
  };
};

const withCredentialsHome = async <A>(
  prefix: string,
  use: (root: string) => Promise<A>,
): Promise<A> => {
  const previousHome = process.env.OBSERVABILITY_HOME;
  const root = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ prefix });
    }).pipe(Effect.provide(BunServices.layer)),
  );
  process.env.OBSERVABILITY_HOME = root;
  try {
    return await use(root);
  } finally {
    if (previousHome === undefined) {
      delete process.env.OBSERVABILITY_HOME;
    } else {
      process.env.OBSERVABILITY_HOME = previousHome;
    }
  }
};

const administrativeCredentials = () => ({
  axiom: new AxiomCredentials({ token: "xapt-secret", organizationId: "org-id" }),
  sentry: new SentryCredentials({
    token: "sentry-secret",
    organization: "maxxi-cash",
    team: "backend",
    baseUrl: new URL("https://sentry.io"),
  }),
});

describe("CredentialsStore", () => {
  test.serial("writes version 2 credentials durably with owner-only permissions", () =>
    withCredentialsHome("observability-credentials-", async (root) => {
      const credentials = administrativeCredentials();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          const fs = yield* FileSystem.FileSystem;
          yield* store.save(new CredentialsFile({ version: 2, ...credentials, environments: [] }));
          const loaded = yield* store.load();
          const info = yield* fs.stat(store.path);
          const lockExists = yield* fs.exists(`${root}/.credentials.lock`);
          return { loaded, lockExists, mode: info.mode & 0o777 };
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );

      expect(result.mode).toBe(0o600);
      expect(result.lockExists).toBeFalse();
      expect(Option.isSome(result.loaded)).toBeTrue();
      if (Option.isSome(result.loaded)) {
        expect(result.loaded.value.version).toBe(2);
        expect(result.loaded.value.axiom?.token).toBe("xapt-secret");
        expect(result.loaded.value.sentry?.baseUrl.toString()).toBe("https://sentry.io/");
      }
    }),
  );

  test.serial("migrates version 1 immediately without changing secrets or permissions", () =>
    withCredentialsHome("observability-migration-", async (root) => {
      const legacy = {
        version: 1,
        axiom: { token: "legacy-axiom-secret", organizationId: "legacy-org" },
        sentry: {
          token: "legacy-sentry-secret",
          organization: "legacy-team",
          team: "backend",
          baseUrl: "https://sentry.io/",
        },
        environments: [
          {
            project: "livro-caixa",
            environment: "staging",
            axiomTokenId: "legacy-token-id",
            axiomToken: "legacy-ingest-secret",
            tracesDataset: "livro-caixa-staging-traces",
            logsDataset: "livro-caixa-staging-logs",
            metricsDataset: "livro-caixa-staging-metrics",
            sentryProject: "livro-caixa",
            sentryDsn: "https://public@sentry.example/1",
          },
        ],
      };
      await Bun.write(`${root}/credentials.json`, `${JSON.stringify(legacy)}\n`);
      await chmod(`${root}/credentials.json`, 0o600);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          const fs = yield* FileSystem.FileSystem;
          const loaded = yield* store.load();
          const content = yield* fs.readFileString(store.path);
          const info = yield* fs.stat(store.path);
          return { loaded, content, mode: info.mode & 0o777 };
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );

      expect(decodePersistedVersion(JSON.parse(result.content)).version).toBe(2);
      expect(result.content).toContain("legacy-axiom-secret");
      expect(result.content).toContain("legacy-sentry-secret");
      expect(result.content).toContain("legacy-ingest-secret");
      expect(result.mode).toBe(0o600);
      expect(Option.isSome(result.loaded)).toBeTrue();
      if (Option.isSome(result.loaded)) {
        expect(result.loaded.value.environments[0]?.providers.type).toBe("combined");
      }
    }),
  );

  test.serial("rejects unsupported versions without replacing the file", () =>
    withCredentialsHome("observability-version-", async (root) => {
      const original = '{"version":3,"environments":[]}\n';
      await Bun.write(`${root}/credentials.json`, original);
      await chmod(`${root}/credentials.json`, 0o600);

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          return yield* Effect.flip(store.load());
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );

      expect(error.code).toBe("OBS_CLI_CREDENTIALS_VERSION_UNSUPPORTED");
      expect(error.message).toContain("Update the CLI");
      expect(await Bun.file(`${root}/credentials.json`).text()).toBe(original);
    }),
  );

  test.serial("fails after waiting 30 seconds for an active credentials lock", () =>
    withCredentialsHome("observability-busy-", async (root) => {
      await mkdir(join(root, ".credentials.lock"), { recursive: true, mode: 0o700 });
      await Bun.write(
        join(root, ".credentials.lock", "owner.json"),
        `${JSON.stringify({ nonce: "active-owner", pid: 1, heartbeat: 1_000_000 })}\n`,
      );
      await chmod(join(root, ".credentials.lock", "owner.json"), 0o600);

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          return yield* Effect.flip(
            store.save(new CredentialsFile({ version: 2, environments: [] })),
          );
        }).pipe(
          Effect.provide(CredentialsStore.layer),
          Effect.provideService(Clock.Clock, makeAdvancingClock()),
          Effect.provide(BunServices.layer),
        ),
      );

      expect(error.code).toBe("OBS_CLI_CREDENTIALS_BUSY");
    }),
  );

  test.serial("binds delayed heartbeats to one lock generation", () =>
    withCredentialsHome("observability-lock-generation-", async (root) => {
      const lockPath = join(root, ".credentials.lock");
      const ownerPath = join(lockPath, "owner.json");
      const staleNonce = "stale-owner";
      await mkdir(lockPath, { recursive: true, mode: 0o700 });
      await Bun.write(
        ownerPath,
        `${JSON.stringify({ nonce: staleNonce, pid: 1, heartbeat: Date.now() - 60_000 })}\n`,
      );
      await chmod(ownerPath, 0o600);

      let signalAcquired = (): void => {};
      let signalRelease = (): void => {};
      const acquired = new Promise<void>((resolve) => {
        signalAcquired = resolve;
      });
      const release = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });
      const owner = Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          yield* store.exclusive(() =>
            Effect.gen(function* () {
              yield* Effect.sync(signalAcquired);
              yield* Effect.promise(() => release);
            }),
          );
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );
      await acquired;

      const currentOwner = decodePersistedLockOwner(JSON.parse(await Bun.file(ownerPath).text()));
      expect(currentOwner.nonce).not.toBe(staleNonce);
      expect(
        await Bun.file(join(root, `.credentials.heartbeat-${currentOwner.nonce}`)).exists(),
      ).toBeTrue();
      await Bun.write(join(root, `.credentials.heartbeat-${staleNonce}`), `${Date.now()}\n`);
      const ownerAfterDelayedHeartbeat = decodePersistedLockOwner(
        JSON.parse(await Bun.file(ownerPath).text()),
      );
      expect(ownerAfterDelayedHeartbeat.nonce).toBe(currentOwner.nonce);

      let contenderFinished = false;
      const contender = Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          yield* store.save(new CredentialsFile({ version: 2, environments: [] }));
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      ).then(() => {
        contenderFinished = true;
      });
      await Bun.sleep(150);
      expect(contenderFinished).toBeFalse();
      signalRelease();
      await owner;
      await contender;
      expect(contenderFinished).toBeTrue();
      await rm(join(root, `.credentials.heartbeat-${staleNonce}`), { force: true });
    }),
  );

  test.serial("rejects a credentials file that other users can read", () =>
    withCredentialsHome("observability-insecure-", async () => {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          const fs = yield* FileSystem.FileSystem;
          yield* store.save(new CredentialsFile({ version: 2, environments: [] }));
          yield* fs.chmod(store.path, 0o644);
          return yield* Effect.flip(store.load());
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );

      expect(error.code).toBe("OBS_CLI_CREDENTIALS_INSECURE");
      expect(error.message).toContain("chmod 600");
    }),
  );
});
