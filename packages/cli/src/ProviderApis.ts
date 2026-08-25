import { Context, Effect, Layer, Schema } from "effect";
import { AxiomCredentials, SentryCredentials } from "./CredentialsStore.ts";

const AxiomUser = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
});

const AxiomDataset = Schema.Struct({ name: Schema.NonEmptyString });
const AxiomDatasets = Schema.Array(AxiomDataset);
const AxiomToken = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString });
const AxiomTokens = Schema.Array(AxiomToken);
const AxiomTokenSecret = Schema.Struct({
  id: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});

const SentryOrganization = Schema.Struct({
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});
const SentryProject = Schema.Struct({
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});
const SentryClientKey = Schema.Struct({
  dsn: Schema.Struct({ public: Schema.NonEmptyString }),
});
const SentryClientKeys = Schema.Array(SentryClientKey);

const decodeAxiomUser = Schema.decodeUnknownEffect(AxiomUser);
const decodeAxiomDatasets = Schema.decodeUnknownEffect(AxiomDatasets);
const decodeAxiomTokens = Schema.decodeUnknownEffect(AxiomTokens);
const decodeAxiomTokenSecret = Schema.decodeUnknownEffect(AxiomTokenSecret);
const decodeSentryOrganization = Schema.decodeUnknownEffect(SentryOrganization);
const decodeSentryProject = Schema.decodeUnknownEffect(SentryProject);
const decodeSentryClientKeys = Schema.decodeUnknownEffect(SentryClientKeys);

export class RemoteApiError extends Schema.TaggedError<RemoteApiError>()("RemoteApiError", {
  code: Schema.Literals([
    "OBS_CLI_REMOTE_UNAUTHORIZED",
    "OBS_CLI_REMOTE_FAILED",
    "OBS_CLI_REMOTE_INVALID_RESPONSE",
  ]),
  message: Schema.String,
  provider: Schema.Literals(["Axiom", "Sentry"]),
  status: Schema.Int,
  cause: Schema.Defect(),
}) {}

type Provider = "Axiom" | "Sentry";

type RemoteResponse = {
  readonly status: number;
  readonly content: string;
};

const remoteRequest = Effect.fn("remoteRequest")(function* (
  provider: Provider,
  url: string,
  init: RequestInit,
): Effect.fn.Return<RemoteResponse, RemoteApiError> {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) =>
      new RemoteApiError({
        code: "OBS_CLI_REMOTE_FAILED",
        message: `${provider} could not be reached. Check the network connection and retry.`,
        provider,
        status: 0,
        cause,
      }),
  });
  const content = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new RemoteApiError({
        code: "OBS_CLI_REMOTE_FAILED",
        message: `${provider} returned an unreadable response. Retry the command.`,
        provider,
        status: response.status,
        cause,
      }),
  });
  if (response.status === 401 || response.status === 403) {
    return yield* new RemoteApiError({
      code: "OBS_CLI_REMOTE_UNAUTHORIZED",
      message: `${provider} rejected the stored credentials. Run observability auth login again.`,
      provider,
      status: response.status,
      cause: response.status,
    });
  }
  return { status: response.status, content };
});

const parseRemoteJson = Effect.fn("parseRemoteJson")(function* (
  provider: Provider,
  response: RemoteResponse,
) {
  return yield* Effect.try({
    try: () => JSON.parse(response.content),
    catch: (cause) =>
      new RemoteApiError({
        code: "OBS_CLI_REMOTE_INVALID_RESPONSE",
        message: `${provider} returned an invalid response. Retry the command.`,
        provider,
        status: response.status,
        cause,
      }),
  });
});

const expectStatus = Effect.fn("expectStatus")(function* (
  provider: Provider,
  response: RemoteResponse,
  accepted: ReadonlyArray<number>,
): Effect.fn.Return<RemoteResponse, RemoteApiError> {
  if (!accepted.includes(response.status)) {
    return yield* new RemoteApiError({
      code: "OBS_CLI_REMOTE_FAILED",
      message: `${provider} returned HTTP ${response.status}. Retry the command or verify the provider configuration.`,
      provider,
      status: response.status,
      cause: response.status,
    });
  }
  return response;
});

const invalidResponse = (provider: Provider, status: number, cause: unknown): RemoteApiError =>
  new RemoteApiError({
    code: "OBS_CLI_REMOTE_INVALID_RESPONSE",
    message: `${provider} returned an invalid response. Retry the command.`,
    provider,
    status,
    cause,
  });

const axiomHeaders = (credentials: AxiomCredentials) => ({
  Authorization: `Bearer ${credentials.token}`,
  "Content-Type": "application/json",
  "X-Axiom-Org-Id": credentials.organizationId,
});

export class AxiomApi extends Context.Service<
  AxiomApi,
  {
    identity(credentials: AxiomCredentials): Effect.Effect<string, RemoteApiError>;
    datasets(credentials: AxiomCredentials): Effect.Effect<ReadonlyArray<string>, RemoteApiError>;
    createDataset(credentials: AxiomCredentials, name: string): Effect.Effect<void, RemoteApiError>;
    tokens(
      credentials: AxiomCredentials,
    ): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>, RemoteApiError>;
    createToken(
      credentials: AxiomCredentials,
      name: string,
      datasets: ReadonlyArray<string>,
    ): Effect.Effect<{ readonly id: string; readonly token: string }, RemoteApiError>;
    regenerateToken(
      credentials: AxiomCredentials,
      id: string,
    ): Effect.Effect<{ readonly id: string; readonly token: string }, RemoteApiError>;
  }
>()("@equipe-tech/observability-cli/AxiomApi") {
  static readonly layer = Layer.succeed(
    AxiomApi,
    AxiomApi.of({
      identity: Effect.fn("AxiomApi.identity")(function* (credentials) {
        const response = yield* remoteRequest("Axiom", "https://api.axiom.co/v2/user", {
          headers: axiomHeaders(credentials),
        });
        yield* expectStatus("Axiom", response, [200]);
        const value = yield* parseRemoteJson("Axiom", response);
        const user = yield* decodeAxiomUser(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
        return user.email;
      }),
      datasets: Effect.fn("AxiomApi.datasets")(function* (credentials) {
        const response = yield* remoteRequest("Axiom", "https://api.axiom.co/v2/datasets", {
          headers: axiomHeaders(credentials),
        });
        yield* expectStatus("Axiom", response, [200]);
        const value = yield* parseRemoteJson("Axiom", response);
        const datasets = yield* decodeAxiomDatasets(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
        return datasets.map((dataset) => dataset.name);
      }),
      createDataset: Effect.fn("AxiomApi.createDataset")(function* (credentials, name) {
        const response = yield* remoteRequest("Axiom", "https://api.axiom.co/v2/datasets", {
          method: "POST",
          headers: axiomHeaders(credentials),
          body: JSON.stringify({ name, description: `OpenTelemetry data for ${name}` }),
        });
        yield* expectStatus("Axiom", response, [200, 201, 409]);
      }),
      tokens: Effect.fn("AxiomApi.tokens")(function* (credentials) {
        const response = yield* remoteRequest("Axiom", "https://api.axiom.co/v2/tokens", {
          headers: axiomHeaders(credentials),
        });
        yield* expectStatus("Axiom", response, [200]);
        const value = yield* parseRemoteJson("Axiom", response);
        return yield* decodeAxiomTokens(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
      }),
      createToken: Effect.fn("AxiomApi.createToken")(function* (credentials, name, datasets) {
        const datasetCapabilities = Object.fromEntries(
          datasets.map((dataset) => [dataset, { ingest: ["create"] }]),
        );
        const response = yield* remoteRequest("Axiom", "https://api.axiom.co/v2/tokens", {
          method: "POST",
          headers: axiomHeaders(credentials),
          body: JSON.stringify({
            name,
            description: `Collector ingest token for ${name}`,
            datasetCapabilities,
            orgCapabilities: {},
            viewCapabilities: {},
          }),
        });
        yield* expectStatus("Axiom", response, [200, 201]);
        const value = yield* parseRemoteJson("Axiom", response);
        return yield* decodeAxiomTokenSecret(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
      }),
      regenerateToken: Effect.fn("AxiomApi.regenerateToken")(function* (credentials, id) {
        const response = yield* remoteRequest(
          "Axiom",
          `https://api.axiom.co/v2/tokens/${encodeURIComponent(id)}/regenerate`,
          { method: "POST", headers: axiomHeaders(credentials) },
        );
        yield* expectStatus("Axiom", response, [200]);
        const value = yield* parseRemoteJson("Axiom", response);
        return yield* decodeAxiomTokenSecret(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
      }),
    }),
  );
}

const sentryHeaders = (credentials: SentryCredentials) => ({
  Authorization: `Bearer ${credentials.token}`,
  "Content-Type": "application/json",
});

const sentryUrl = (credentials: SentryCredentials, path: string): string =>
  new URL(path, `${credentials.baseUrl.toString().replace(/\/$/, "")}/`).toString();

export class SentryApi extends Context.Service<
  SentryApi,
  {
    identity(credentials: SentryCredentials): Effect.Effect<string, RemoteApiError>;
    ensureProject(
      credentials: SentryCredentials,
      slug: string,
      platform: string,
    ): Effect.Effect<string, RemoteApiError>;
    dsn(credentials: SentryCredentials, project: string): Effect.Effect<string, RemoteApiError>;
  }
>()("@equipe-tech/observability-cli/SentryApi") {
  static readonly layer = Layer.succeed(
    SentryApi,
    SentryApi.of({
      identity: Effect.fn("SentryApi.identity")(function* (credentials) {
        const organizationPath = `/api/0/organizations/${encodeURIComponent(credentials.organization)}/`;
        const response = yield* remoteRequest("Sentry", sentryUrl(credentials, organizationPath), {
          headers: sentryHeaders(credentials),
        });
        yield* expectStatus("Sentry", response, [200]);
        const value = yield* parseRemoteJson("Sentry", response);
        const organization = yield* decodeSentryOrganization(value).pipe(
          Effect.mapError((cause) => invalidResponse("Sentry", response.status, cause)),
        );
        return organization.name;
      }),
      ensureProject: Effect.fn("SentryApi.ensureProject")(function* (credentials, slug, platform) {
        const projectPath = `/api/0/projects/${encodeURIComponent(credentials.organization)}/${encodeURIComponent(slug)}/`;
        const existing = yield* remoteRequest("Sentry", sentryUrl(credentials, projectPath), {
          headers: sentryHeaders(credentials),
        });
        if (existing.status === 200) {
          const value = yield* parseRemoteJson("Sentry", existing);
          const project = yield* decodeSentryProject(value).pipe(
            Effect.mapError((cause) => invalidResponse("Sentry", existing.status, cause)),
          );
          return project.slug;
        }
        yield* expectStatus("Sentry", existing, [404]);
        const createPath = `/api/0/teams/${encodeURIComponent(credentials.organization)}/${encodeURIComponent(credentials.team)}/projects/`;
        const created = yield* remoteRequest("Sentry", sentryUrl(credentials, createPath), {
          method: "POST",
          headers: sentryHeaders(credentials),
          body: JSON.stringify({ name: slug, slug, platform }),
        });
        if (created.status === 409) {
          return slug;
        }
        yield* expectStatus("Sentry", created, [200, 201]);
        const value = yield* parseRemoteJson("Sentry", created);
        const project = yield* decodeSentryProject(value).pipe(
          Effect.mapError((cause) => invalidResponse("Sentry", created.status, cause)),
        );
        return project.slug;
      }),
      dsn: Effect.fn("SentryApi.dsn")(function* (credentials, project) {
        const keysPath = `/api/0/projects/${encodeURIComponent(credentials.organization)}/${encodeURIComponent(project)}/keys/`;
        const response = yield* remoteRequest("Sentry", sentryUrl(credentials, keysPath), {
          headers: sentryHeaders(credentials),
        });
        yield* expectStatus("Sentry", response, [200]);
        const value = yield* parseRemoteJson("Sentry", response);
        const keys = yield* decodeSentryClientKeys(value).pipe(
          Effect.mapError((cause) => invalidResponse("Sentry", response.status, cause)),
        );
        const key = keys[0];
        if (key === undefined) {
          return yield* new RemoteApiError({
            code: "OBS_CLI_REMOTE_FAILED",
            message: `Sentry project ${project} has no client key. Create a client key and retry.`,
            provider: "Sentry",
            status: 404,
            cause: project,
          });
        }
        return key.dsn.public;
      }),
    }),
  );
}
