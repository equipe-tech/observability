import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import {
  AxiomCredentials,
  CredentialsAccess,
  CredentialsError,
  CredentialsFile,
  CredentialsStore,
  PendingAxiomMutation,
  SentryCredentials,
} from "../src/CredentialsStore.ts";
import { AxiomApi, RemoteApiError, SentryApi } from "../src/ProviderApis.ts";
import {
  environmentAxiom,
  environmentDatasets,
  environmentSentry,
  parseEnvironmentName,
  parseProviderSelection,
  RemoteEnvironment,
} from "../src/RemoteEnvironment.ts";

type RemoteOptions = {
  readonly axiom?: boolean;
  readonly sentry?: boolean;
};

const makeRemoteLayer = (options: RemoteOptions = {}) => {
  const includeAxiom = options.axiom ?? true;
  const includeSentry = options.sentry ?? true;
  const axiom = includeAxiom
    ? new AxiomCredentials({ token: "xapt-admin", organizationId: "org-id" })
    : undefined;
  const sentry = includeSentry
    ? new SentryCredentials({
        token: "sentry-admin",
        organization: "maxxi-cash",
        team: "backend",
        baseUrl: new URL("https://sentry.io"),
      })
    : undefined;
  let credentials =
    axiom !== undefined && sentry !== undefined
      ? new CredentialsFile({ version: 2, axiom, sentry, environments: [] })
      : axiom !== undefined
        ? new CredentialsFile({ version: 2, axiom, environments: [] })
        : sentry !== undefined
          ? new CredentialsFile({ version: 2, sentry, environments: [] })
          : new CredentialsFile({ version: 2, environments: [] });
  const datasets: Array<string> = [];
  const tokens: Array<{ readonly id: string; readonly name: string }> = [];
  let tokenCreations = 0;
  let tokenRegenerations = 0;
  let axiomDatasetLists = 0;
  let axiomTokenLists = 0;
  let sentryProjectCalls = 0;
  let sentryDsnCalls = 0;
  let failedDataset = Option.none<string>();
  let failSentry = false;
  let failedTokenMutation = Option.none<{
    readonly status: number;
    readonly code: "OBS_CLI_REMOTE_FAILED" | "OBS_CLI_REMOTE_INVALID_RESPONSE";
  }>();
  let failedSaveCall = Option.none<number>();
  let saveCalls = 0;

  const access: CredentialsAccess = {
    load: () => Effect.succeed(Option.some(credentials)),
    save: (next) => {
      saveCalls += 1;
      if (Option.contains(failedSaveCall, saveCalls)) {
        return Effect.fail(
          new CredentialsError({
            code: "OBS_CLI_CREDENTIALS_FAILED",
            message: "The credentials file could not be saved.",
            cause: "test-save-failure",
          }),
        );
      }
      return Effect.sync(() => {
        credentials = next;
      });
    },
  };
  const store = CredentialsStore.of({
    path: "/private/credentials.json",
    load: () => access.load(),
    save: (next) => access.save(next),
    exclusive: (use) => use(access),
  });
  const axiomApi = AxiomApi.of({
    identity: () => Effect.succeed("owner@example.com"),
    datasets: () =>
      Effect.sync(() => {
        axiomDatasetLists += 1;
        return datasets;
      }),
    createDataset: (_credentials, name) => {
      if (Option.contains(failedDataset, name)) {
        return Effect.fail(
          new RemoteApiError({
            code: "OBS_CLI_REMOTE_FAILED",
            message: "Axiom returned HTTP 500. Retry the command.",
            provider: "Axiom",
            status: 500,
            cause: name,
          }),
        );
      }
      return Effect.sync(() => {
        datasets.push(name);
      });
    },
    tokens: () =>
      Effect.sync(() => {
        axiomTokenLists += 1;
        return tokens;
      }),
    createToken: (_credentials, name) => {
      if (Option.isSome(failedTokenMutation)) {
        return Effect.fail(
          new RemoteApiError({
            code: failedTokenMutation.value.code,
            message: "Axiom token mutation failed.",
            provider: "Axiom",
            status: failedTokenMutation.value.status,
            cause: name,
          }),
        );
      }
      return Effect.sync(() => {
        tokenCreations += 1;
        const token = { id: `token-${tokenCreations}`, name };
        tokens.push(token);
        return { id: token.id, token: `secret-${tokenCreations}` };
      });
    },
    regenerateToken: (_credentials, id) =>
      Effect.sync(() => {
        tokenRegenerations += 1;
        return { id, token: `rotated-${tokenRegenerations}` };
      }),
  });
  const sentryApi = SentryApi.of({
    identity: () => Effect.succeed("Maxxi Cash"),
    ensureProject: (_credentials, slug) => {
      sentryProjectCalls += 1;
      if (failSentry) {
        return Effect.fail(
          new RemoteApiError({
            code: "OBS_CLI_REMOTE_FAILED",
            message: "Sentry returned HTTP 500. Retry the command.",
            provider: "Sentry",
            status: 500,
            cause: slug,
          }),
        );
      }
      return Effect.succeed(slug);
    },
    dsn: () =>
      Effect.sync(() => {
        sentryDsnCalls += 1;
        return "https://public@sentry.example/1";
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(CredentialsStore, store),
    Layer.succeed(AxiomApi, axiomApi),
    Layer.succeed(SentryApi, sentryApi),
  );

  return {
    layer: RemoteEnvironment.layer.pipe(Layer.provide(dependencies)),
    failDataset: (name: string) => {
      failedDataset = Option.some(name);
    },
    failSentry: () => {
      failSentry = true;
    },
    failTokenMutation: (
      status = 201,
      code:
        | "OBS_CLI_REMOTE_FAILED"
        | "OBS_CLI_REMOTE_INVALID_RESPONSE" = "OBS_CLI_REMOTE_INVALID_RESPONSE",
    ) => {
      failedTokenMutation = Option.some({ status, code });
    },
    failSaveAt: (call: number) => {
      failedSaveCall = Option.some(call);
    },
    markPendingAxiomMutation: (project: string, environment: string) => {
      const pendingAxiomMutations = [new PendingAxiomMutation({ project, environment })];
      credentials =
        credentials.axiom !== undefined && credentials.sentry !== undefined
          ? new CredentialsFile({
              version: 2,
              axiom: credentials.axiom,
              sentry: credentials.sentry,
              environments: credentials.environments,
              pendingAxiomMutations,
            })
          : credentials.axiom !== undefined
            ? new CredentialsFile({
                version: 2,
                axiom: credentials.axiom,
                environments: credentials.environments,
                pendingAxiomMutations,
              })
            : credentials.sentry !== undefined
              ? new CredentialsFile({
                  version: 2,
                  sentry: credentials.sentry,
                  environments: credentials.environments,
                  pendingAxiomMutations,
                })
              : new CredentialsFile({
                  version: 2,
                  environments: credentials.environments,
                  pendingAxiomMutations,
                });
    },
    state: () => ({
      credentials,
      datasets,
      tokens,
      tokenCreations,
      tokenRegenerations,
      axiomDatasetLists,
      axiomTokenLists,
      sentryProjectCalls,
      sentryDsnCalls,
      saveCalls,
    }),
  };
};

describe("environment and provider names", () => {
  test("builds one dataset per signal and environment", async () => {
    const result = await Effect.runPromise(environmentDatasets("livro-caixa", "staging"));
    expect(result).toEqual({
      traces: "livro-caixa-staging-traces",
      logs: "livro-caixa-staging-logs",
      metrics: "livro-caixa-staging-metrics",
    });
  });

  test("rejects malformed environment and provider names", async () => {
    const environment = await Effect.runPromise(Effect.flip(parseEnvironmentName("Production US")));
    const provider = await Effect.runPromise(Effect.flip(parseProviderSelection(["honeycomb"])));
    expect(environment.code).toBe("OBS_CLI_REMOTE_INVALID_ENVIRONMENT");
    expect(provider.code).toBe("OBS_CLI_REMOTE_INVALID_PROVIDER");
  });

  test("deduplicates providers in canonical order", async () => {
    const providers = await Effect.runPromise(
      parseProviderSelection(["sentry", "axiom", "sentry"]),
    );
    expect(providers).toEqual(["axiom", "sentry"]);
  });
});

describe("RemoteEnvironment", () => {
  test("preserves combined omission behavior and repeats without duplicate resources", async () => {
    const remote = makeRemoteLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        const first = yield* service.provision("livro-caixa", ["staging"], [], "node", false);
        const second = yield* service.provision("livro-caixa", ["staging"], [], "node", false);
        const exported = yield* service.export("livro-caixa", "staging");
        return { first, second, exported };
      }).pipe(Effect.provide(remote.layer)),
    );
    const state = remote.state();

    expect(result.first[0]?.providers.type).toBe("combined");
    expect(result.second[0]?.providers.type).toBe("combined");
    expect(state.datasets).toHaveLength(3);
    expect(state.tokenCreations).toBe(1);
    expect(state.sentryProjectCalls).toBe(2);
    expect(state.credentials.environments).toHaveLength(1);
    expect(result.exported.split("\n")).toHaveLength(8);
    expect(result.exported).toContain('AXIOM_TOKEN="secret-1"');
    expect(result.exported).toContain('SENTRY_DSN="https://public@sentry.example/1"');
  });

  test("provisions and repeats Axiom without calling Sentry", async () => {
    const remote = makeRemoteLayer({ sentry: false });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["staging"], ["axiom"], "node", false);
        const repeated = yield* service.provision("livro-caixa", ["staging"], [], "node", false);
        return {
          repeated,
          exported: yield* service.export("livro-caixa", "staging"),
        };
      }).pipe(Effect.provide(remote.layer)),
    );
    const state = remote.state();

    expect(result.repeated[0]?.providers.type).toBe("axiom");
    expect(state.sentryProjectCalls).toBe(0);
    expect(state.sentryDsnCalls).toBe(0);
    expect(state.tokenCreations).toBe(1);
    expect(result.exported.split("\n")).toHaveLength(7);
    expect(result.exported).not.toContain("SENTRY_DSN");
  });

  test("provisions and repeats Sentry without calling Axiom", async () => {
    const remote = makeRemoteLayer({ axiom: false });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["staging"], ["sentry"], "node", false);
        const repeated = yield* service.provision("livro-caixa", ["staging"], [], "node", false);
        return {
          repeated,
          exported: yield* service.export("livro-caixa", "staging"),
        };
      }).pipe(Effect.provide(remote.layer)),
    );
    const state = remote.state();

    expect(result.repeated[0]?.providers.type).toBe("sentry");
    expect(state.axiomDatasetLists).toBe(0);
    expect(state.axiomTokenLists).toBe(0);
    expect(result.exported).toBe(
      'OTEL_SERVICE_NAME="livro-caixa"\nOTEL_DEPLOYMENT_ENVIRONMENT="staging"\nSENTRY_DSN="https://public@sentry.example/1"',
    );
  });

  test("adds an explicitly selected provider to existing state", async () => {
    const remote = makeRemoteLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["staging"], ["sentry"], "node", false);
        return yield* service.provision("livro-caixa", ["staging"], ["axiom"], "node", false);
      }).pipe(Effect.provide(remote.layer)),
    );

    const managed = result[0];
    expect(managed?.providers.type).toBe("combined");
    if (managed !== undefined) {
      expect(Option.isSome(environmentAxiom(managed))).toBeTrue();
      expect(Option.isSome(environmentSentry(managed))).toBeTrue();
    }
  });

  test("preserves the combined missing-credentials error when both providers are absent", async () => {
    const remote = makeRemoteLayer({ axiom: false, sentry: false });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(service.provision("livro-caixa", ["staging"], [], "node", false));
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_CREDENTIALS_MISSING");
    }
    expect(remote.state().axiomDatasetLists).toBe(0);
    expect(remote.state().sentryProjectCalls).toBe(0);
  });

  test("requires only selected provider credentials before provider calls", async () => {
    const remote = makeRemoteLayer({ axiom: false });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_PROVIDER_CREDENTIALS_MISSING");
      expect(error.message).toContain("auth login axiom");
    }
    expect(remote.state().axiomDatasetLists).toBe(0);
    expect(remote.state().sentryProjectCalls).toBe(0);
  });

  test("requires rotation when the remote token has no local secret", async () => {
    const remote = makeRemoteLayer();
    remote.state().tokens.push({
      id: "existing-token",
      name: "livro-caixa-staging-collector",
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
      expect(error.message).toContain("--rotate-token");
    }
  });

  test("rotates Axiom state and preserves Sentry", async () => {
    const remote = makeRemoteLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["production"], [], "node", false);
        return yield* service.provision("livro-caixa", ["production"], ["axiom"], "node", true);
      }).pipe(Effect.provide(remote.layer)),
    );
    const managed = result[0];

    expect(remote.state().tokenRegenerations).toBe(1);
    expect(managed?.providers.type).toBe("combined");
    if (managed !== undefined) {
      expect(Option.getOrThrow(environmentAxiom(managed)).token).toBe("rotated-1");
      expect(Option.getOrThrow(environmentSentry(managed)).project).toBe("livro-caixa");
    }
  });

  test("rejects a stale local token after an unresolved mutation until explicit rotation", async () => {
    const remote = makeRemoteLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["production"], ["axiom"], "node", false);
      }).pipe(Effect.provide(remote.layer)),
    );
    remote.markPendingAxiomMutation("livro-caixa", "production");
    const callsBeforeRecovery = remote.state();
    const exportError = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(service.export("livro-caixa", "production"));
      }).pipe(Effect.provide(remote.layer)),
    );
    expect(exportError._tag).toBe("RemoteEnvironmentError");
    if (exportError._tag === "RemoteEnvironmentError") {
      expect(exportError.code).toBe("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
    }

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["production"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
      expect(error.message).toContain("--rotate-token");
    }
    expect(remote.state().axiomDatasetLists).toBe(callsBeforeRecovery.axiomDatasetLists);
    expect(remote.state().axiomTokenLists).toBe(callsBeforeRecovery.axiomTokenLists);

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* service.provision("livro-caixa", ["production"], ["axiom"], "node", true);
      }).pipe(Effect.provide(remote.layer)),
    );
    const recoveredEnvironment = recovered[0];
    expect(recoveredEnvironment).toBeDefined();
    if (recoveredEnvironment !== undefined) {
      expect(Option.getOrThrow(environmentAxiom(recoveredEnvironment)).token).toBe("rotated-1");
    }
    expect(remote.state().credentials.pendingAxiomMutations).toBeUndefined();
  });

  test("rejects rotation before provider calls when any environment excludes Axiom", async () => {
    const remote = makeRemoteLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["staging"], ["sentry"], "node", false);
      }).pipe(Effect.provide(remote.layer)),
    );
    const calls = remote.state();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(service.provision("livro-caixa", ["staging"], [], "node", true));
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_ROTATION_NOT_SELECTED");
    }
    expect(remote.state().axiomDatasetLists).toBe(calls.axiomDatasetLists);
    expect(remote.state().sentryProjectCalls).toBe(calls.sentryProjectCalls);
  });

  test("does not mutate an Axiom token when Sentry fails first", async () => {
    const remote = makeRemoteLayer();
    remote.failSentry();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(service.provision("livro-caixa", ["staging"], [], "node", false));
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteApiError");
    expect(remote.state().axiomDatasetLists).toBe(0);
    expect(remote.state().tokenCreations).toBe(0);
  });

  test("classifies an unreadable token mutation response as outcome unknown", async () => {
    const remote = makeRemoteLayer();
    remote.failTokenMutation();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
      expect(error.message).toContain("Rotate the token");
    }
    expect(remote.state().credentials.environments).toHaveLength(0);
  });

  test("clears pending state only for definite HTTP 4xx token rejection", async () => {
    const remote = makeRemoteLayer();
    remote.failTokenMutation(400, "OBS_CLI_REMOTE_FAILED");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteApiError");
    expect(remote.state().credentials.pendingAxiomMutations).toBeUndefined();
  });

  test("classifies HTTP 5xx token mutation responses as outcome unknown", async () => {
    const remote = makeRemoteLayer();
    remote.failTokenMutation(503, "OBS_CLI_REMOTE_FAILED");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
      expect(error.message).toContain("Rotate the token");
    }
    expect(remote.state().credentials.environments).toHaveLength(0);
  });

  test("classifies token mutation transport failures as outcome unknown", async () => {
    const remote = makeRemoteLayer();
    remote.failTokenMutation(0, "OBS_CLI_REMOTE_FAILED");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
    }
    expect(remote.state().credentials.pendingAxiomMutations).toEqual([
      { project: "livro-caixa", environment: "staging" },
    ]);
  });

  test("keeps pending state for successful-status token body failures", async () => {
    for (const status of [200, 201]) {
      const remote = makeRemoteLayer();
      remote.failTokenMutation(status, "OBS_CLI_REMOTE_FAILED");
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* RemoteEnvironment;
          return yield* Effect.flip(
            service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
          );
        }).pipe(Effect.provide(remote.layer)),
      );

      expect(error._tag).toBe("RemoteEnvironmentError");
      if (error._tag === "RemoteEnvironmentError") {
        expect(error.code).toBe("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
      }
      expect(remote.state().credentials.pendingAxiomMutations).toEqual([
        { project: "livro-caixa", environment: "staging" },
      ]);
    }
  });

  test("keeps pending state for unexpected successful token statuses", async () => {
    for (const status of [202, 204]) {
      const remote = makeRemoteLayer();
      remote.failTokenMutation(status, "OBS_CLI_REMOTE_FAILED");
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* RemoteEnvironment;
          return yield* Effect.flip(
            service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
          );
        }).pipe(Effect.provide(remote.layer)),
      );

      expect(error._tag).toBe("RemoteEnvironmentError");
      if (error._tag === "RemoteEnvironmentError") {
        expect(error.code).toBe("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
      }
      expect(remote.state().credentials.pendingAxiomMutations).toEqual([
        { project: "livro-caixa", environment: "staging" },
      ]);
    }
  });

  test("classifies a failed checkpoint after token creation as outcome unknown", async () => {
    const remote = makeRemoteLayer();
    remote.failSaveAt(2);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
      expect(error.message).toContain("Rotate the token");
    }
    expect(remote.state().tokenCreations).toBe(1);
    expect(remote.state().credentials.environments).toHaveLength(0);
  });

  test("keeps an earlier checkpoint when a later environment fails", async () => {
    const remote = makeRemoteLayer();
    remote.failDataset("livro-caixa-production-traces");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        return yield* Effect.flip(
          service.provision("livro-caixa", ["staging", "production"], ["axiom"], "node", false),
        );
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_PARTIAL_FAILURE");
      expect(error.message).toContain("livro-caixa/staging");
    }
    expect(remote.state().credentials.environments.map((item) => item.environment)).toEqual([
      "staging",
    ]);
  });
});
