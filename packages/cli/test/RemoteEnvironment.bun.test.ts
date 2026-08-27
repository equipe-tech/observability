import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import {
  AxiomCredentials,
  CredentialsFile,
  CredentialsStore,
  SentryCredentials,
} from "../src/CredentialsStore.ts";
import { AxiomApi, SentryApi } from "../src/ProviderApis.ts";
import {
  environmentDatasets,
  parseEnvironmentName,
  RemoteEnvironment,
} from "../src/RemoteEnvironment.ts";

const makeRemoteLayer = () => {
  let credentials = new CredentialsFile({
    version: 1,
    axiom: new AxiomCredentials({ token: "xapt-admin", organizationId: "org-id" }),
    sentry: new SentryCredentials({
      token: "sentry-admin",
      organization: "maxxi-cash",
      team: "backend",
      baseUrl: new URL("https://sentry.io"),
    }),
    environments: [],
  });
  const datasets: Array<string> = [];
  const tokens: Array<{ readonly id: string; readonly name: string }> = [];
  let tokenCreations = 0;
  let tokenRegenerations = 0;

  const store = CredentialsStore.of({
    path: "/private/credentials.json",
    load: () => Effect.succeed(Option.some(credentials)),
    save: (next) =>
      Effect.sync(() => {
        credentials = next;
      }),
  });
  const axiom = AxiomApi.of({
    identity: () => Effect.succeed("owner@example.com"),
    datasets: () => Effect.succeed(datasets),
    createDataset: (_credentials, name) =>
      Effect.sync(() => {
        datasets.push(name);
      }),
    tokens: () => Effect.succeed(tokens),
    createToken: (_credentials, name) =>
      Effect.sync(() => {
        tokenCreations += 1;
        const token = { id: `token-${tokenCreations}`, name };
        tokens.push(token);
        return { id: token.id, token: `secret-${tokenCreations}` };
      }),
    regenerateToken: (_credentials, id) =>
      Effect.sync(() => {
        tokenRegenerations += 1;
        return { id, token: `rotated-${tokenRegenerations}` };
      }),
  });
  const sentry = SentryApi.of({
    identity: () => Effect.succeed("Maxxi Cash"),
    ensureProject: (_credentials, slug) => Effect.succeed(slug),
    dsn: () => Effect.succeed("https://public@sentry.example/1"),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(CredentialsStore, store),
    Layer.succeed(AxiomApi, axiom),
    Layer.succeed(SentryApi, sentry),
  );

  return {
    layer: RemoteEnvironment.layer.pipe(Layer.provide(dependencies)),
    state: () => ({ credentials, datasets, tokens, tokenCreations, tokenRegenerations }),
  };
};

describe("environment names", () => {
  test("builds one dataset per signal and environment", async () => {
    const result = await Effect.runPromise(environmentDatasets("livro-caixa", "staging"));
    expect(result).toEqual({
      traces: "livro-caixa-staging-traces",
      logs: "livro-caixa-staging-logs",
      metrics: "livro-caixa-staging-metrics",
    });
  });

  test("rejects malformed environment names", async () => {
    const error = await Effect.runPromise(Effect.flip(parseEnvironmentName("Production US")));
    expect(error.code).toBe("OBS_CLI_REMOTE_INVALID_ENVIRONMENT");
  });
});

describe("RemoteEnvironment", () => {
  test("provisions isolated datasets and one reusable ingest token", async () => {
    const remote = makeRemoteLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        const first = yield* service.provision("livro-caixa", ["staging"], "node", false);
        const second = yield* service.provision("livro-caixa", ["staging"], "node", false);
        const exported = yield* service.export("livro-caixa", "staging");
        return { first, second, exported };
      }).pipe(Effect.provide(remote.layer)),
    );
    const state = remote.state();

    expect(result.first).toHaveLength(1);
    expect(result.second).toHaveLength(1);
    expect(state.datasets).toEqual([
      "livro-caixa-staging-traces",
      "livro-caixa-staging-logs",
      "livro-caixa-staging-metrics",
    ]);
    expect(state.tokenCreations).toBe(1);
    expect(state.credentials.environments).toHaveLength(1);
    expect(result.exported).toContain('OTEL_DEPLOYMENT_ENVIRONMENT="staging"');
    expect(result.exported).toContain(
      'OTEL_EXPORTER_OTLP_ENDPOINT="http://livro-caixa-otel-collector:4318"',
    );
    expect(result.exported).not.toContain(
      'OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"',
    );
    expect(result.exported).toContain('AXIOM_TOKEN="secret-1"');
    expect(result.exported).toContain('SENTRY_DSN="https://public@sentry.example/1"');
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
        return yield* Effect.flip(service.provision("livro-caixa", ["staging"], "node", false));
      }).pipe(Effect.provide(remote.layer)),
    );

    expect(error._tag).toBe("RemoteEnvironmentError");
    if (error._tag === "RemoteEnvironmentError") {
      expect(error.code).toBe("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
      expect(error.message).toContain("--rotate-token");
      expect(error.message).not.toContain("xapt-admin");
      expect(error.message).not.toContain("sentry-admin");
    }
  });

  test("rotates an existing Axiom token only when requested", async () => {
    const remote = makeRemoteLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RemoteEnvironment;
        yield* service.provision("livro-caixa", ["production"], "node", false);
        return yield* service.provision("livro-caixa", ["production"], "node", true);
      }).pipe(Effect.provide(remote.layer)),
    );
    const state = remote.state();

    expect(state.tokenCreations).toBe(1);
    expect(state.tokenRegenerations).toBe(1);
    expect(result[0]?.axiomToken).toBe("rotated-1");
    expect(state.credentials.environments[0]?.axiomToken).toBe("rotated-1");
  });
});
