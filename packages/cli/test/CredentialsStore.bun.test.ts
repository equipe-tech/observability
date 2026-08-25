import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import {
  AxiomCredentials,
  CredentialsFile,
  CredentialsStore,
  SentryCredentials,
} from "../src/CredentialsStore.ts";

describe("CredentialsStore", () => {
  test.serial("writes credentials with owner-only permissions and reads them back", async () => {
    const previousHome = process.env.OBSERVABILITY_HOME;
    const root = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-credentials-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    process.env.OBSERVABILITY_HOME = root;

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          const fs = yield* FileSystem.FileSystem;
          yield* store.save(
            new CredentialsFile({
              version: 1,
              axiom: new AxiomCredentials({
                token: "xapt-secret",
                organizationId: "org-id",
              }),
              sentry: new SentryCredentials({
                token: "sentry-secret",
                organization: "maxxi-cash",
                team: "backend",
                baseUrl: new URL("https://sentry.io"),
              }),
              environments: [],
            }),
          );
          const loaded = yield* store.load();
          const info = yield* fs.stat(store.path);
          return { loaded, mode: info.mode & 0o777 };
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );

      expect(result.mode).toBe(0o600);
      expect(Option.isSome(result.loaded)).toBeTrue();
      if (Option.isSome(result.loaded)) {
        expect(result.loaded.value.axiom?.organizationId).toBe("org-id");
        expect(result.loaded.value.axiom?.token).toBe("xapt-secret");
        expect(result.loaded.value.sentry?.organization).toBe("maxxi-cash");
        expect(result.loaded.value.sentry?.baseUrl.toString()).toBe("https://sentry.io/");
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.OBSERVABILITY_HOME;
      } else {
        process.env.OBSERVABILITY_HOME = previousHome;
      }
    }
  });

  test.serial("rejects a credentials file that other users can read", async () => {
    const previousHome = process.env.OBSERVABILITY_HOME;
    const root = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-insecure-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    process.env.OBSERVABILITY_HOME = root;

    try {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialsStore;
          const fs = yield* FileSystem.FileSystem;
          yield* store.save(new CredentialsFile({ version: 1, environments: [] }));
          yield* fs.chmod(store.path, 0o644);
          return yield* Effect.flip(store.load());
        }).pipe(Effect.provide(CredentialsStore.layer), Effect.provide(BunServices.layer)),
      );

      expect(error.code).toBe("OBS_CLI_CREDENTIALS_INSECURE");
      expect(error.message).toContain("chmod 600");
    } finally {
      if (previousHome === undefined) {
        delete process.env.OBSERVABILITY_HOME;
      } else {
        process.env.OBSERVABILITY_HOME = previousHome;
      }
    }
  });
});
