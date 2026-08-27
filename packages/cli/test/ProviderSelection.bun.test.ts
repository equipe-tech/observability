import { beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { chmod, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const PersistedCredentials = Schema.Struct({
  version: Schema.Literal(3),
  axiom: Schema.Struct({ token: Schema.NonEmptyString }).pipe(Schema.optionalKey),
  sentry: Schema.Struct({ token: Schema.NonEmptyString }).pipe(Schema.optionalKey),
  environments: Schema.Array(
    Schema.Struct({
      project: Schema.String,
      environment: Schema.String,
      providers: Schema.Struct({ type: Schema.Literals(["axiom", "sentry", "combined"]) }),
    }),
  ),
});
const decodePersistedCredentials = Schema.decodeUnknownSync(PersistedCredentials);

type ProviderRequest = {
  readonly method: string;
  readonly path: string;
  readonly body: string;
};

type ProviderServer = {
  readonly url: string;
  readonly requests: Array<ProviderRequest>;
  readonly datasets: Set<string>;
  readonly tokens: Array<{
    id: string;
    name: string;
    token: string;
    description: string;
    datasetCapabilities: { readonly [name: string]: { readonly ingest: ReadonlyArray<string> } };
  }>;
  failDataset(name: string): void;
  failNextSentryProject(): void;
  failNextTokenResponse(): void;
  stop(): void;
};

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ProviderResponsePayload = typeof Schema.Json.Type;

const json = (value: ProviderResponsePayload, status = 200): Response =>
  Response.json(value, { status, headers: { "content-type": "application/json" } });

const startProviderServer = (): ProviderServer => {
  const requests: Array<ProviderRequest> = [];
  const datasets = new Set<string>();
  const tokens: Array<{
    id: string;
    name: string;
    token: string;
    description: string;
    datasetCapabilities: { readonly [name: string]: { readonly ingest: ReadonlyArray<string> } };
  }> = [];
  let sentryProject = false;
  let tokenSequence = 0;
  let failSentryProject = false;
  let failTokenResponse = false;
  const failedDatasets = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/v2/user") {
        return json({ id: "owner", email: "owner@example.com" });
      }
      if (request.method === "GET" && url.pathname === "/v2/datasets") {
        return json(
          [...datasets].map((name, index) => ({
            id: `dataset-${index + 1}`,
            name,
            description: `OpenTelemetry data for ${name}`,
            kind: name.endsWith("-metrics") ? "otel:metrics:v1" : "axiom:events:v1",
            edgeDeployment: "edge-main",
            useRetentionPeriod: false,
          })),
        );
      }
      if (request.method === "POST" && url.pathname === "/v2/datasets") {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            name: Schema.NonEmptyString,
            description: Schema.String,
            kind: Schema.Literals(["axiom:events:v1", "otel:metrics:v1"]),
            edgeDeployment: Schema.NonEmptyString.pipe(Schema.optionalKey),
          }),
        )(JSON.parse(body));
        if (failedDatasets.has(value.name)) {
          return json({ error: "selected failure" }, 500);
        }
        datasets.add(value.name);
        return json(
          {
            id: `dataset-${datasets.size}`,
            name: value.name,
            description: value.description,
            kind: value.kind,
            edgeDeployment: value.edgeDeployment ?? "edge-main",
            useRetentionPeriod: false,
          },
          201,
        );
      }
      if (request.method === "GET" && url.pathname === "/v2/tokens") {
        return json(
          tokens.map(({ datasetCapabilities, description, id, name }) => ({
            id,
            name,
            description,
            datasetCapabilities,
            orgCapabilities: {},
          })),
        );
      }
      if (request.method === "POST" && url.pathname === "/v2/tokens") {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            name: Schema.NonEmptyString,
            description: Schema.String,
            datasetCapabilities: Schema.Record(
              Schema.NonEmptyString,
              Schema.Struct({ ingest: Schema.Array(Schema.NonEmptyString) }),
            ),
          }),
        )(JSON.parse(body));
        tokenSequence += 1;
        const token = {
          id: `token-${tokenSequence}`,
          name: value.name,
          token: `ingest-secret-${tokenSequence}`,
          description: value.description,
          datasetCapabilities: value.datasetCapabilities,
        };
        tokens.push(token);
        if (failTokenResponse) {
          failTokenResponse = false;
          return new Response("{", { status: 201 });
        }
        return json({ id: token.id, token: token.token }, 201);
      }
      const regenerate = url.pathname.match(/^\/v2\/tokens\/([^/]+)\/regenerate$/);
      if (request.method === "POST" && regenerate !== null) {
        const id = decodeURIComponent(regenerate[1] ?? "");
        const token = tokens.find((candidate) => candidate.id === id);
        if (token === undefined) {
          return json({ error: "missing" }, 404);
        }
        tokenSequence += 1;
        token.token = `ingest-secret-${tokenSequence}`;
        return json({ id: token.id, token: token.token });
      }
      if (
        request.method === "GET" &&
        /^\/api\/0\/projects\/maxxi-cash\/[^/]+\/$/.test(url.pathname)
      ) {
        if (failSentryProject) {
          failSentryProject = false;
          return json({ error: "selected failure" }, 500);
        }
        const slug = url.pathname.split("/").at(-2) ?? "";
        return sentryProject ? json({ slug, name: slug }) : json({ detail: "missing" }, 404);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/0/teams/maxxi-cash/backend/projects/"
      ) {
        const value = Schema.decodeUnknownSync(Schema.Struct({ slug: Schema.NonEmptyString }))(
          JSON.parse(body),
        );
        sentryProject = true;
        return json({ slug: value.slug, name: value.slug }, 201);
      }
      if (
        request.method === "GET" &&
        /^\/api\/0\/projects\/maxxi-cash\/[^/]+\/keys\/$/.test(url.pathname)
      ) {
        return json([{ dsn: { public: "https://public@sentry.example/1" } }]);
      }
      return json({ error: "unexpected request" }, 500);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    datasets,
    tokens,
    failDataset: (name) => {
      failedDatasets.add(name);
    },
    failNextSentryProject: () => {
      failSentryProject = true;
    },
    failNextTokenResponse: () => {
      failTokenResponse = true;
    },
    stop: () => server.stop(true),
  };
};

const credentialsDocument = (
  sentryBaseUrl: string,
  providers: ReadonlyArray<"axiom" | "sentry">,
): string => {
  const axiom = { token: "axiom-admin-secret", organizationId: "org-id" };
  const sentry = {
    token: "sentry-admin-secret",
    organization: "maxxi-cash",
    team: "backend",
    baseUrl: sentryBaseUrl,
  };
  const document = providers.includes("axiom")
    ? providers.includes("sentry")
      ? { version: 2, axiom, sentry, environments: [] }
      : { version: 2, axiom, environments: [] }
    : { version: 2, sentry, environments: [] };
  return `${JSON.stringify(document, undefined, 2)}\n`;
};

const writeCredentials = async (
  root: string,
  sentryBaseUrl: string,
  providers: ReadonlyArray<"axiom" | "sentry">,
): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "credentials.json");
  await Bun.write(path, credentialsDocument(sentryBaseUrl, providers));
  await chmod(path, 0o600);
};

const runCli = (
  args: ReadonlyArray<string>,
  stateRoot: string,
  target: string,
  server: ProviderServer,
): Promise<CliResult> => {
  const child = Bun.spawn(["bun", cli, ...args], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      NO_COLOR: "1",
      OBSERVABILITY_HOME: stateRoot,
      OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: server.url,
    },
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
};

const provisionArgs = (
  target: string,
  environment: string,
  providers: ReadonlyArray<"axiom" | "sentry">,
): ReadonlyArray<string> => {
  const args = [
    "provision",
    "--dir",
    target,
    "--name",
    "livro-caixa",
    "--environment",
    environment,
    ...providers.flatMap((provider) => ["--provider", provider]),
  ];
  if (providers.includes("axiom") || providers.length === 0) {
    return [...args, "--axiom-edge-deployment", "edge-main", "--correlation-confirmed"];
  }
  return args;
};

const assertNoSecretOutput = (result: CliResult): void => {
  for (const secret of [
    "axiom-admin-secret",
    "sentry-admin-secret",
    "ingest-secret-",
    "https://public@sentry.example/1",
  ]) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
};

const readPersisted = async (root: string) => {
  const content = await Bun.file(join(root, "credentials.json")).text();
  return decodePersistedCredentials(JSON.parse(content));
};

beforeAll(async () => {
  const child = Bun.spawn(["bun", "run", "build"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  expect(exitCode).toBe(0);
});

describe("built CLI provider selection", () => {
  test.serial(
    "drives Axiom-only, Sentry-only and combined state through loopback providers",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "observability-provider-cli-"));
      const server = startProviderServer();
      try {
        const axiomRoot = join(root, "axiom-state");
        const axiomTarget = join(root, "axiom-target");
        await writeCredentials(axiomRoot, server.url, ["axiom"]);
        const axiomFirst = await runCli(
          provisionArgs(axiomTarget, "staging", ["axiom"]),
          axiomRoot,
          axiomTarget,
          server,
        );
        const axiomRepeat = await runCli(
          provisionArgs(axiomTarget, "staging", []),
          axiomRoot,
          axiomTarget,
          server,
        );
        const axiomExport = await runCli(
          ["env", "export", "--name", "livro-caixa", "--environment", "staging"],
          axiomRoot,
          axiomTarget,
          server,
        );
        expect(axiomFirst.exitCode).toBe(0);
        expect(axiomRepeat.exitCode).toBe(0);
        expect(axiomExport.stdout.trim().split("\n")).toEqual([
          'OTEL_SERVICE_NAME="livro-caixa"',
          'OTEL_DEPLOYMENT_ENVIRONMENT="staging"',
          'OTEL_EXPORTER_OTLP_ENDPOINT="http://livro-caixa-otel-collector:4318"',
          'AXIOM_TOKEN="ingest-secret-1"',
          'AXIOM_DATASET_TRACES="livro-caixa-staging-traces"',
          'AXIOM_DATASET_LOGS="livro-caixa-staging-logs"',
          'AXIOM_DATASET_METRICS="livro-caixa-staging-metrics"',
        ]);
        expect(
          server.requests.filter((request) => request.path.startsWith("/api/0/")),
        ).toHaveLength(0);
        expect(
          server.requests.filter(
            (request) => request.method === "POST" && request.path === "/v2/tokens",
          ),
        ).toHaveLength(1);
        expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
          "GET /v2/datasets",
          "GET /v2/tokens",
          "POST /v2/datasets",
          "POST /v2/datasets",
          "POST /v2/datasets",
          "POST /v2/tokens",
          "GET /v2/datasets",
          "GET /v2/datasets",
          "GET /v2/tokens",
          "GET /v2/datasets",
        ]);
        expect(
          server.requests
            .filter((request) => request.path === "/v2/datasets" && request.method === "POST")
            .map((request) => JSON.parse(request.body)),
        ).toEqual([
          {
            name: "livro-caixa-staging-traces",
            description: "OpenTelemetry data for livro-caixa-staging-traces",
            kind: "axiom:events:v1",
            edgeDeployment: "edge-main",
          },
          {
            name: "livro-caixa-staging-logs",
            description: "OpenTelemetry data for livro-caixa-staging-logs",
            kind: "axiom:events:v1",
            edgeDeployment: "edge-main",
          },
          {
            name: "livro-caixa-staging-metrics",
            description: "OpenTelemetry data for livro-caixa-staging-metrics",
            kind: "otel:metrics:v1",
            edgeDeployment: "edge-main",
          },
        ]);
        const axiomTokenRequest = server.requests.find(
          (request) => request.path === "/v2/tokens" && request.method === "POST",
        );
        expect(axiomTokenRequest).toBeDefined();
        if (axiomTokenRequest !== undefined) {
          expect(JSON.parse(axiomTokenRequest.body)).toEqual({
            name: "livro-caixa-staging-collector",
            description: "Collector ingest token for livro-caixa-staging-collector",
            datasetCapabilities: {
              "livro-caixa-staging-traces": { ingest: ["create"] },
              "livro-caixa-staging-logs": { ingest: ["create"] },
              "livro-caixa-staging-metrics": { ingest: ["create"] },
            },
            orgCapabilities: {},
            viewCapabilities: {},
          });
        }
        assertNoSecretOutput(axiomFirst);
        assertNoSecretOutput(axiomRepeat);

        const sentryRequestStart = server.requests.length;
        const sentryRoot = join(root, "sentry-state");
        const sentryTarget = join(root, "sentry-target");
        await writeCredentials(sentryRoot, server.url, ["sentry"]);
        const sentryFirst = await runCli(
          provisionArgs(sentryTarget, "production", ["sentry"]),
          sentryRoot,
          sentryTarget,
          server,
        );
        const sentryRepeat = await runCli(
          provisionArgs(sentryTarget, "production", []),
          sentryRoot,
          sentryTarget,
          server,
        );
        const sentryExport = await runCli(
          ["env", "export", "--name", "livro-caixa", "--environment", "production"],
          sentryRoot,
          sentryTarget,
          server,
        );
        expect(sentryFirst.exitCode).toBe(0);
        expect(sentryRepeat.exitCode).toBe(0);
        expect(sentryFirst.stdout).toContain("Sentry-only command");
        expect(sentryExport.stdout.trim()).toBe(
          'OTEL_SERVICE_NAME="livro-caixa"\nOTEL_DEPLOYMENT_ENVIRONMENT="production"\nSENTRY_DSN="https://public@sentry.example/1"',
        );
        const sentryRequests = server.requests.slice(sentryRequestStart);
        expect(sentryRequests.filter((request) => request.path.startsWith("/v2/"))).toHaveLength(0);
        expect(sentryRequests.map((request) => `${request.method} ${request.path}`)).toEqual([
          "GET /api/0/projects/maxxi-cash/livro-caixa/",
          "POST /api/0/teams/maxxi-cash/backend/projects/",
          "GET /api/0/projects/maxxi-cash/livro-caixa/keys/",
          "GET /api/0/projects/maxxi-cash/livro-caixa/",
          "GET /api/0/projects/maxxi-cash/livro-caixa/keys/",
        ]);
        expect(JSON.parse(sentryRequests[1]?.body ?? "")).toEqual({
          name: "livro-caixa",
          slug: "livro-caixa",
          platform: "node",
        });
        assertNoSecretOutput(sentryFirst);
        assertNoSecretOutput(sentryRepeat);

        const combinedRequestStart = server.requests.length;
        const combinedRoot = join(root, "combined-state");
        const combinedTarget = join(root, "combined-target");
        await writeCredentials(combinedRoot, server.url, ["axiom", "sentry"]);
        const combined = await runCli(
          provisionArgs(combinedTarget, "canary", []),
          combinedRoot,
          combinedTarget,
          server,
        );
        const combinedRepeat = await runCli(
          provisionArgs(combinedTarget, "canary", ["sentry", "axiom", "sentry"]),
          combinedRoot,
          combinedTarget,
          server,
        );
        expect(combined.exitCode).toBe(0);
        expect(combinedRepeat.exitCode).toBe(0);
        expect(combined.stdout).toContain("providers=axiom,sentry");
        expect(combinedRepeat.stdout).toContain("providers=axiom,sentry");
        assertNoSecretOutput(combinedRepeat);
        const combinedExport = await runCli(
          ["env", "export", "--name", "livro-caixa", "--environment", "canary"],
          combinedRoot,
          combinedTarget,
          server,
        );
        expect(combinedExport.exitCode).toBe(0);
        expect(combinedExport.stdout.trim().split("\n")).toEqual([
          'OTEL_SERVICE_NAME="livro-caixa"',
          'OTEL_DEPLOYMENT_ENVIRONMENT="canary"',
          'OTEL_EXPORTER_OTLP_ENDPOINT="http://livro-caixa-otel-collector:4318"',
          'AXIOM_TOKEN="ingest-secret-2"',
          'AXIOM_DATASET_TRACES="livro-caixa-canary-traces"',
          'AXIOM_DATASET_LOGS="livro-caixa-canary-logs"',
          'AXIOM_DATASET_METRICS="livro-caixa-canary-metrics"',
          'SENTRY_DSN="https://public@sentry.example/1"',
        ]);
        expect(
          server.requests
            .slice(combinedRequestStart)
            .map((request) => `${request.method} ${request.path}`),
        ).toEqual([
          "GET /v2/datasets",
          "GET /v2/tokens",
          "GET /api/0/projects/maxxi-cash/livro-caixa/",
          "GET /api/0/projects/maxxi-cash/livro-caixa/keys/",
          "POST /v2/datasets",
          "POST /v2/datasets",
          "POST /v2/datasets",
          "POST /v2/tokens",
          "GET /v2/datasets",
          "GET /v2/datasets",
          "GET /v2/tokens",
          "GET /api/0/projects/maxxi-cash/livro-caixa/",
          "GET /api/0/projects/maxxi-cash/livro-caixa/keys/",
          "GET /v2/datasets",
        ]);
        expect((await readPersisted(combinedRoot)).environments[0]?.providers.type).toBe(
          "combined",
        );
        expect((await stat(join(combinedRoot, "credentials.json"))).mode & 0o777).toBe(0o600);
        assertNoSecretOutput(combined);
      } finally {
        server.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.serial(
    "rejects invalid and missing selections before provider requests and preserves no-environment compatibility",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "observability-provider-errors-"));
      const server = startProviderServer();
      try {
        const stateRoot = join(root, "state");
        const target = join(root, "target");
        await writeCredentials(stateRoot, server.url, ["sentry"]);

        for (const rejectedEnvironment of [
          {
            NODE_ENV: "test",
            OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: "http://localhost:4318",
          },
          {
            NODE_ENV: "production",
            OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: server.url,
          },
        ]) {
          const child = Bun.spawn(["bun", cli, "--version"], {
            cwd: repository,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...rejectedEnvironment, NO_COLOR: "1" },
          });
          const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          expect(exitCode).toBe(1);
          expect(stderr).toContain("The internal Axiom test endpoint is invalid");
        }

        const invalid = await runCli(
          [
            "provision",
            "--dir",
            target,
            "--name",
            "livro-caixa",
            "--environment",
            "staging",
            "--provider",
            "honeycomb",
          ],
          stateRoot,
          target,
          server,
        );
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr).toContain("OBS_CLI_REMOTE_INVALID_PROVIDER");
        expect(
          await Bun.file(join(target, "observability", "collector.yaml")).exists(),
        ).toBeFalse();
        expect(server.requests).toHaveLength(0);

        const invalidEnvironmentTarget = join(root, "invalid-environment-target");
        const invalidEnvironment = await runCli(
          provisionArgs(invalidEnvironmentTarget, "Production US", ["sentry"]),
          stateRoot,
          invalidEnvironmentTarget,
          server,
        );
        expect(invalidEnvironment.exitCode).toBe(1);
        expect(invalidEnvironment.stderr).toContain("OBS_CLI_REMOTE_INVALID_ENVIRONMENT");
        expect(
          await Bun.file(
            join(invalidEnvironmentTarget, "observability", "collector.yaml"),
          ).exists(),
        ).toBeFalse();
        expect(server.requests).toHaveLength(0);

        const missing = await runCli(
          provisionArgs(target, "staging", ["axiom"]),
          stateRoot,
          target,
          server,
        );
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain("OBS_CLI_REMOTE_PROVIDER_CREDENTIALS_MISSING");
        expect(server.requests).toHaveLength(0);

        const localOnly = await runCli(
          [
            "provision",
            "--dir",
            target,
            "--name",
            "livro-caixa",
            "--provider",
            "sentry",
            "--rotate-token",
            "--sentry-platform",
            "javascript",
          ],
          stateRoot,
          target,
          server,
        );
        expect(localOnly.exitCode).toBe(0);
        expect(localOnly.stdout).toContain("set the AXIOM_TOKEN secret");
        expect(server.requests).toHaveLength(0);
        assertNoSecretOutput(localOnly);
      } finally {
        server.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.serial(
    "migrates legacy state, rotates Axiom, and serializes concurrent subprocess updates",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "observability-provider-state-"));
      const server = startProviderServer();
      try {
        const migrationRoot = join(root, "migration-state");
        const migrationTarget = join(root, "migration-target");
        await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
        const legacy = {
          version: 1,
          axiom: { token: "legacy-admin", organizationId: "org-id" },
          sentry: {
            token: "legacy-sentry",
            organization: "maxxi-cash",
            team: "backend",
            baseUrl: server.url,
          },
          environments: [
            {
              project: "livro-caixa",
              environment: "legacy",
              axiomTokenId: "legacy-id",
              axiomToken: "legacy-ingest-secret",
              tracesDataset: "livro-caixa-legacy-traces",
              logsDataset: "livro-caixa-legacy-logs",
              metricsDataset: "livro-caixa-legacy-metrics",
              sentryProject: "livro-caixa",
              sentryDsn: "https://legacy@sentry.example/1",
            },
          ],
        };
        const migrationPath = join(migrationRoot, "credentials.json");
        await Bun.write(migrationPath, `${JSON.stringify(legacy)}\n`);
        await chmod(migrationPath, 0o600);
        const migratedExport = await runCli(
          ["env", "export", "--name", "livro-caixa", "--environment", "legacy"],
          migrationRoot,
          migrationTarget,
          server,
        );
        expect(migratedExport.exitCode).toBe(1);
        expect(migratedExport.stderr).toContain("OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED");
        const migratedContent = await Bun.file(migrationPath).text();
        expect(migratedContent).toContain("legacy-ingest-secret");
        expect(migratedContent).toContain("https://legacy@sentry.example/1");
        expect((await readPersisted(migrationRoot)).version).toBe(3);
        expect((await stat(migrationPath)).mode & 0o777).toBe(0o600);
        const rotated = await runCli(
          [...provisionArgs(migrationTarget, "legacy", ["axiom"]), "--rotate-token"],
          migrationRoot,
          migrationTarget,
          server,
        );
        expect(rotated.exitCode).toBe(0);
        expect(
          server.requests.filter(
            (request) => request.method === "POST" && request.path === "/v2/tokens",
          ),
        ).toHaveLength(1);
        assertNoSecretOutput(rotated);

        const rotatedDocument = JSON.parse(await Bun.file(migrationPath).text());
        rotatedDocument.pendingAxiomMutations = [{ project: "livro-caixa", environment: "legacy" }];
        await Bun.write(migrationPath, `${JSON.stringify(rotatedDocument, undefined, 2)}\n`);
        await chmod(migrationPath, 0o600);
        const requestsBeforeUnresolvedRetry = server.requests.length;
        const unresolvedExport = await runCli(
          ["env", "export", "--name", "livro-caixa", "--environment", "legacy"],
          migrationRoot,
          migrationTarget,
          server,
        );
        expect(unresolvedExport.exitCode).toBe(1);
        expect(unresolvedExport.stderr).toContain("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
        expect(server.requests).toHaveLength(requestsBeforeUnresolvedRetry);
        const unresolvedRetry = await runCli(
          provisionArgs(migrationTarget, "legacy", ["axiom"]),
          migrationRoot,
          migrationTarget,
          server,
        );
        expect(unresolvedRetry.exitCode).toBe(1);
        expect(unresolvedRetry.stderr).toContain("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
        expect(unresolvedRetry.stderr).toContain("--rotate-token");
        expect(server.requests).toHaveLength(requestsBeforeUnresolvedRetry);
        const recoveredRotation = await runCli(
          [...provisionArgs(migrationTarget, "legacy", ["axiom"]), "--rotate-token"],
          migrationRoot,
          migrationTarget,
          server,
        );
        expect(recoveredRotation.exitCode).toBe(0);
        expect(
          JSON.parse(await Bun.file(migrationPath).text()).pendingAxiomMutations,
        ).toBeUndefined();
        assertNoSecretOutput(unresolvedExport);
        assertNoSecretOutput(unresolvedRetry);
        assertNoSecretOutput(recoveredRotation);

        const sentryFailureRoot = join(root, "sentry-failure-state");
        const sentryFailureTarget = join(root, "sentry-failure-target");
        await writeCredentials(sentryFailureRoot, server.url, ["axiom", "sentry"]);
        const axiomCallsBeforeSentryFailure = server.requests.filter((request) =>
          request.path.startsWith("/v2/"),
        ).length;
        server.failNextSentryProject();
        const sentryFailure = await runCli(
          provisionArgs(sentryFailureTarget, "sentry-failure", ["axiom", "sentry"]),
          sentryFailureRoot,
          sentryFailureTarget,
          server,
        );
        expect(sentryFailure.exitCode).toBe(1);
        expect(sentryFailure.stderr).toContain("OBS_CLI_REMOTE_FAILED");
        expect(server.requests.filter((request) => request.path.startsWith("/v2/")).length).toBe(
          axiomCallsBeforeSentryFailure + 2,
        );
        expect((await readPersisted(sentryFailureRoot)).environments).toHaveLength(0);
        assertNoSecretOutput(sentryFailure);

        const partialRoot = join(root, "partial-state");
        const partialTarget = join(root, "partial-target");
        await writeCredentials(partialRoot, server.url, ["axiom"]);
        server.failDataset("livro-caixa-partial-two-traces");
        const partial = await runCli(
          [
            "provision",
            "--dir",
            partialTarget,
            "--name",
            "livro-caixa",
            "--environment",
            "partial-one",
            "--environment",
            "partial-two",
            "--provider",
            "axiom",
          ],
          partialRoot,
          partialTarget,
          server,
        );
        expect(partial.exitCode).toBe(1);
        expect(partial.stderr).toContain("OBS_CLI_REMOTE_PARTIAL_FAILURE");
        expect(partial.stderr).toContain("livro-caixa/partial-one");
        expect(
          (await readPersisted(partialRoot)).environments.map((item) => item.environment),
        ).toEqual(["partial-one"]);
        assertNoSecretOutput(partial);

        const unknownRoot = join(root, "unknown-state");
        const unknownTarget = join(root, "unknown-target");
        await writeCredentials(unknownRoot, server.url, ["axiom"]);
        server.failNextTokenResponse();
        const unknown = await runCli(
          provisionArgs(unknownTarget, "unknown", ["axiom"]),
          unknownRoot,
          unknownTarget,
          server,
        );
        expect(unknown.exitCode).toBe(1);
        expect(unknown.stderr).toContain("OBS_CLI_REMOTE_OUTCOME_UNKNOWN");
        expect((await readPersisted(unknownRoot)).environments).toHaveLength(0);
        expect(
          JSON.parse(await Bun.file(join(unknownRoot, "credentials.json")).text()),
        ).toMatchObject({
          pendingAxiomMutations: [{ project: "livro-caixa", environment: "unknown" }],
        });
        const requestsBeforeUnknownRetry = server.requests.length;
        const unknownRetry = await runCli(
          provisionArgs(unknownTarget, "unknown", ["axiom"]),
          unknownRoot,
          unknownTarget,
          server,
        );
        expect(unknownRetry.exitCode).toBe(1);
        expect(unknownRetry.stderr).toContain("OBS_CLI_REMOTE_TOKEN_UNAVAILABLE");
        expect(server.requests).toHaveLength(requestsBeforeUnknownRetry);
        const unknownRecovery = await runCli(
          [...provisionArgs(unknownTarget, "unknown", ["axiom"]), "--rotate-token"],
          unknownRoot,
          unknownTarget,
          server,
        );
        expect(unknownRecovery.exitCode).toBe(0);
        expect(
          JSON.parse(await Bun.file(join(unknownRoot, "credentials.json")).text())
            .pendingAxiomMutations,
        ).toBeUndefined();
        assertNoSecretOutput(unknown);
        assertNoSecretOutput(unknownRetry);
        assertNoSecretOutput(unknownRecovery);

        const concurrentRoot = join(root, "concurrent-state");
        const concurrentTarget = join(root, "concurrent-target");
        await writeCredentials(concurrentRoot, server.url, ["axiom"]);
        const local = await runCli(
          ["provision", "--dir", concurrentTarget, "--name", "livro-caixa"],
          concurrentRoot,
          concurrentTarget,
          server,
        );
        expect(local.exitCode).toBe(0);
        const [staging, production] = await Promise.all([
          runCli(
            provisionArgs(concurrentTarget, "staging", ["axiom"]),
            concurrentRoot,
            concurrentTarget,
            server,
          ),
          runCli(
            provisionArgs(concurrentTarget, "production", ["axiom"]),
            concurrentRoot,
            concurrentTarget,
            server,
          ),
        ]);
        expect(staging.exitCode).toBe(0);
        expect(production.exitCode).toBe(0);
        const persisted = await readPersisted(concurrentRoot);
        expect(persisted.environments.map((environment) => environment.environment).sort()).toEqual(
          ["production", "staging"],
        );
        expect(persisted.axiom?.token).toBe("axiom-admin-secret");
        expect((await stat(join(concurrentRoot, "credentials.json"))).mode & 0o777).toBe(0o600);
        assertNoSecretOutput(staging);
        assertNoSecretOutput(production);
      } finally {
        server.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
