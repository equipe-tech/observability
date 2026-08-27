import { Context, Effect, Layer, Schema } from "effect";
import {
  AxiomDatasetRetentionDays,
  AxiomDatasetRetentionInvariant,
} from "./AxiomDatasetRetention.ts";
import { AxiomCredentials, SentryCredentials } from "./CredentialsStore.ts";

const AxiomUser = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
});

export const AxiomDatasetKind = Schema.Literals([
  "axiom:events:v1",
  "otel:logs:v1",
  "otel:metrics:v1",
  "otel:traces:v1",
]);
export type AxiomDatasetKind = typeof AxiomDatasetKind.Type;

export class AxiomDataset extends Schema.Class<AxiomDataset>(
  "@equipe-tech/observability-cli/AxiomDataset",
)(
  Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    description: Schema.String,
    kind: AxiomDatasetKind,
    edgeDeployment: Schema.NonEmptyString.pipe(Schema.optionalKey),
    retentionDays: AxiomDatasetRetentionDays,
    useRetentionPeriod: Schema.Boolean,
  }).check(AxiomDatasetRetentionInvariant),
) {}

const AxiomDatasets = Schema.Array(AxiomDataset);
const AxiomCapabilityActions = Schema.Array(Schema.NonEmptyString);
const AxiomDatasetCapability = Schema.Record(Schema.NonEmptyString, AxiomCapabilityActions);
export const AxiomDatasetCapabilities = Schema.Record(
  Schema.NonEmptyString,
  AxiomDatasetCapability,
);
const AxiomOrganizationCapabilities = Schema.Record(Schema.NonEmptyString, AxiomCapabilityActions);
const AxiomTokenDescription = Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")));
const AxiomViewCapabilities = Schema.Record(Schema.NonEmptyString, AxiomCapabilityActions).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

export class AxiomToken extends Schema.Class<AxiomToken>(
  "@equipe-tech/observability-cli/AxiomToken",
)({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: AxiomTokenDescription,
  expiresAt: Schema.String.pipe(Schema.optionalKey),
  datasetCapabilities: AxiomDatasetCapabilities,
  orgCapabilities: AxiomOrganizationCapabilities,
  viewCapabilities: AxiomViewCapabilities,
}) {}

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
const decodeAxiomDataset = Schema.decodeUnknownEffect(AxiomDataset);
const decodeAxiomDatasets = Schema.decodeUnknownEffect(AxiomDatasets);
const decodeAxiomTokens = Schema.decodeUnknownEffect(AxiomTokens);
const decodeAxiomTokenSecret = Schema.decodeUnknownEffect(AxiomTokenSecret);
const decodeSentryOrganization = Schema.decodeUnknownEffect(SentryOrganization);
const decodeSentryProject = Schema.decodeUnknownEffect(SentryProject);
const decodeSentryClientKeys = Schema.decodeUnknownEffect(SentryClientKeys);
const AxiomTestEnvironment = Schema.Struct({
  NODE_ENV: Schema.NonEmptyString.pipe(Schema.optionalKey),
  OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: Schema.NonEmptyString.pipe(Schema.optionalKey),
});
const decodeAxiomTestEnvironment = Schema.decodeUnknownEffect(AxiomTestEnvironment);
const decodeAxiomTestUrl = Schema.decodeUnknownEffect(Schema.URLFromString);

export type AxiomDatasetCreateOptions = {
  readonly kind?: AxiomDatasetKind;
  readonly edgeDeployment?: string;
  readonly retentionDays?: number;
};

export class RemoteApiError extends Schema.TaggedError<RemoteApiError>()("RemoteApiError", {
  code: Schema.Literals([
    "OBS_CLI_REMOTE_UNAUTHORIZED",
    "OBS_CLI_REMOTE_FAILED",
    "OBS_CLI_REMOTE_INVALID_RESPONSE",
    "OBS_CLI_AXIOM_DATASET_CONFLICT",
    "OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN",
  ]),
  message: Schema.String,
  provider: Schema.Literals(["Axiom", "Sentry"]),
  status: Schema.Int,
  cause: Schema.Defect(),
}) {}

type Provider = "Axiom" | "Sentry";

const invalidAxiomTestEndpoint = (cause: unknown): RemoteApiError =>
  new RemoteApiError({
    code: "OBS_CLI_REMOTE_FAILED",
    message: "The internal Axiom test endpoint is invalid.",
    provider: "Axiom",
    status: 0,
    cause,
  });

const resolveAxiomBaseUrl = Effect.fn("resolveAxiomBaseUrl")(function* () {
  const environment = yield* decodeAxiomTestEnvironment(process.env).pipe(
    Effect.mapError(invalidAxiomTestEndpoint),
  );
  const configured = environment.OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL;
  if (configured === undefined) {
    return new URL("https://api.axiom.co");
  }
  if (environment.NODE_ENV !== "test") {
    return yield* invalidAxiomTestEndpoint("NODE_ENV");
  }
  const endpoint = yield* decodeAxiomTestUrl(configured).pipe(
    Effect.mapError(invalidAxiomTestEndpoint),
  );
  const host = endpoint.hostname;
  const ipv4Loopback = /^127(?:[.]\d{1,3}){3}$/.test(host);
  const ipv6Loopback = host === "[::1]";
  const hasCredentials = endpoint.username !== "" || endpoint.password !== "";
  if (endpoint.protocol !== "http:" || (!ipv4Loopback && !ipv6Loopback) || hasCredentials) {
    return yield* invalidAxiomTestEndpoint(configured);
  }
  if (ipv4Loopback) {
    const octets = host.split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return yield* invalidAxiomTestEndpoint(configured);
    }
  }
  return endpoint;
});

const axiomUrl = (baseUrl: URL, remotePath: string): string =>
  new URL(remotePath, `${baseUrl.toString().replace(/\/$/, "")}/`).toString();

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
    try: (signal) => fetch(url, { ...init, redirect: "error", signal }),
    catch: (cause) =>
      new RemoteApiError({
        code: "OBS_CLI_REMOTE_FAILED",
        message: `${provider} could not be reached. Check the network connection and retry.`,
        provider,
        status: 0,
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

const desiredDatasetKind = (options: AxiomDatasetCreateOptions): AxiomDatasetKind =>
  options.kind ?? "axiom:events:v1";

const datasetMatches = (dataset: AxiomDataset, options: AxiomDatasetCreateOptions): boolean => {
  if (dataset.kind !== desiredDatasetKind(options)) {
    return false;
  }
  if (options.edgeDeployment !== undefined && dataset.edgeDeployment !== options.edgeDeployment) {
    return false;
  }
  return (
    options.retentionDays === undefined ||
    (dataset.useRetentionPeriod && dataset.retentionDays === options.retentionDays)
  );
};

const datasetBody = (name: string, options: AxiomDatasetCreateOptions) => {
  const body: {
    name: string;
    description: string;
    kind: AxiomDatasetKind;
    edgeDeployment?: string;
    retentionDays?: number;
    useRetentionPeriod?: boolean;
  } = {
    name,
    description: `OpenTelemetry data for ${name}`,
    kind: desiredDatasetKind(options),
  };
  if (options.edgeDeployment !== undefined) {
    body.edgeDeployment = options.edgeDeployment;
  }
  if (options.retentionDays !== undefined) {
    body.retentionDays = options.retentionDays;
    body.useRetentionPeriod = true;
  }
  return body;
};

const tokenCapabilities = (datasets: ReadonlyArray<string>) =>
  Object.fromEntries(datasets.map((dataset) => [dataset, { ingest: ["create"] }]));

export class AxiomApi extends Context.Service<
  AxiomApi,
  {
    identity(credentials: AxiomCredentials): Effect.Effect<string, RemoteApiError>;
    datasets(
      credentials: AxiomCredentials,
    ): Effect.Effect<ReadonlyArray<AxiomDataset>, RemoteApiError>;
    createDataset(
      credentials: AxiomCredentials,
      name: string,
      options?: AxiomDatasetCreateOptions,
    ): Effect.Effect<AxiomDataset, RemoteApiError>;
    tokens(credentials: AxiomCredentials): Effect.Effect<ReadonlyArray<AxiomToken>, RemoteApiError>;
    createToken(
      credentials: AxiomCredentials,
      name: string,
      datasets: ReadonlyArray<string>,
    ): Effect.Effect<{ readonly id: string; readonly token: string }, RemoteApiError>;
    regenerateToken(
      credentials: AxiomCredentials,
      token: AxiomToken,
      datasets: ReadonlyArray<string>,
    ): Effect.Effect<{ readonly id: string; readonly token: string }, RemoteApiError>;
  }
>()("@equipe-tech/observability-cli/AxiomApi") {
  static readonly layer = Layer.effect(
    AxiomApi,
    Effect.gen(function* () {
      const baseUrl = yield* resolveAxiomBaseUrl();

      const listDatasets = Effect.fn("AxiomApi.datasets")(function* (credentials) {
        const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, "/v2/datasets"), {
          headers: axiomHeaders(credentials),
        });
        yield* expectStatus("Axiom", response, [200]);
        const value = yield* parseRemoteJson("Axiom", response);
        return yield* decodeAxiomDatasets(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
      });

      const recoverDataset = Effect.fn("AxiomApi.recoverDataset")(function* (
        credentials: AxiomCredentials,
        name: string,
        options: AxiomDatasetCreateOptions,
        original: RemoteApiError,
      ): Effect.fn.Return<AxiomDataset, RemoteApiError> {
        const matches = (yield* listDatasets(credentials)).filter(
          (dataset) => dataset.name === name,
        );
        const match = matches[0];
        if (matches.length === 1 && match !== undefined && datasetMatches(match, options)) {
          return match;
        }
        if (matches.length > 0 || original.status === 409) {
          return yield* new RemoteApiError({
            code: "OBS_CLI_AXIOM_DATASET_CONFLICT",
            message: `Axiom dataset ${name} does not match the requested configuration. Review its kind, edge deployment and retention before retrying.`,
            provider: "Axiom",
            status: original.status,
            cause: original,
          });
        }
        if (
          original.status === 0 ||
          original.status >= 500 ||
          original.code === "OBS_CLI_REMOTE_INVALID_RESPONSE" ||
          (original.status >= 200 && original.status < 300)
        ) {
          return yield* new RemoteApiError({
            code: "OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN",
            message: `The outcome of creating Axiom dataset ${name} is unknown. Verify the remote dataset before retrying.`,
            provider: "Axiom",
            status: original.status,
            cause: original,
          });
        }
        return yield* original;
      });

      const parseDatasetResponse = Effect.fn("AxiomApi.parseDatasetResponse")(function* (
        response: RemoteResponse,
      ) {
        const value = yield* parseRemoteJson("Axiom", response);
        return yield* decodeAxiomDataset(value).pipe(
          Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
        );
      });

      return AxiomApi.of({
        identity: Effect.fn("AxiomApi.identity")(function* (credentials) {
          const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, "/v2/user"), {
            headers: axiomHeaders(credentials),
          });
          yield* expectStatus("Axiom", response, [200]);
          const value = yield* parseRemoteJson("Axiom", response);
          const user = yield* decodeAxiomUser(value).pipe(
            Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
          );
          return user.email;
        }),
        datasets: listDatasets,
        createDataset: Effect.fn("AxiomApi.createDataset")(function* (
          credentials,
          name,
          options = {},
        ) {
          const mutation = Effect.gen(function* () {
            const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, "/v2/datasets"), {
              method: "POST",
              headers: axiomHeaders(credentials),
              body: JSON.stringify(datasetBody(name, options)),
            });
            yield* expectStatus("Axiom", response, [200, 201]);
            const dataset = yield* parseDatasetResponse(response);
            if (dataset.name !== name || !datasetMatches(dataset, options)) {
              return yield* new RemoteApiError({
                code: "OBS_CLI_REMOTE_INVALID_RESPONSE",
                message: `Axiom returned a dataset that does not match ${name}. Verify the remote resource before retrying.`,
                provider: "Axiom",
                status: response.status,
                cause: dataset,
              });
            }
            return dataset;
          });
          return yield* mutation.pipe(
            Effect.catchTag("RemoteApiError", (error) =>
              recoverDataset(credentials, name, options, error),
            ),
          );
        }),
        tokens: Effect.fn("AxiomApi.tokens")(function* (credentials) {
          const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, "/v2/tokens"), {
            headers: axiomHeaders(credentials),
          });
          yield* expectStatus("Axiom", response, [200]);
          const value = yield* parseRemoteJson("Axiom", response);
          return yield* decodeAxiomTokens(value).pipe(
            Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
          );
        }),
        createToken: Effect.fn("AxiomApi.createToken")(function* (credentials, name, datasets) {
          const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, "/v2/tokens"), {
            method: "POST",
            headers: axiomHeaders(credentials),
            body: JSON.stringify({
              name,
              description: `Collector ingest token for ${name}`,
              datasetCapabilities: tokenCapabilities(datasets),
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
        regenerateToken: Effect.fn("AxiomApi.regenerateToken")(
          function* (credentials, token, datasets) {
            const response = yield* remoteRequest(
              "Axiom",
              axiomUrl(baseUrl, `/v2/tokens/${encodeURIComponent(token.id)}/regenerate`),
              {
                method: "POST",
                headers: axiomHeaders(credentials),
                body: JSON.stringify({
                  newToken: {
                    name: token.name,
                    description: token.description,
                    datasetCapabilities: tokenCapabilities(datasets),
                    orgCapabilities: {},
                    viewCapabilities: {},
                  },
                }),
              },
            );
            yield* expectStatus("Axiom", response, [200]);
            const value = yield* parseRemoteJson("Axiom", response);
            return yield* decodeAxiomTokenSecret(value).pipe(
              Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
            );
          },
        ),
      });
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
