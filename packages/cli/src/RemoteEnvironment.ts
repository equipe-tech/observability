import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  AxiomCredentials,
  CredentialsError,
  CredentialsFile,
  CredentialsStore,
  emptyCredentials,
  ManagedEnvironment,
  SentryCredentials,
} from "./CredentialsStore.ts";
import { AxiomApi, RemoteApiError, SentryApi } from "./ProviderApis.ts";

const EnvironmentName = Schema.NonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    expected: "a lowercase environment name with letters, digits and single dashes",
  }),
);
const DatasetName = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const decodeEnvironmentName = Schema.decodeUnknownEffect(EnvironmentName);
const decodeDatasetName = Schema.decodeUnknownEffect(DatasetName);

export class RemoteEnvironmentError extends Schema.TaggedError<RemoteEnvironmentError>()(
  "RemoteEnvironmentError",
  {
    code: Schema.Literals([
      "OBS_CLI_REMOTE_CREDENTIALS_MISSING",
      "OBS_CLI_REMOTE_INVALID_ENVIRONMENT",
      "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
      "OBS_CLI_REMOTE_ENVIRONMENT_NOT_FOUND",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type EnvironmentDatasets = {
  readonly traces: string;
  readonly logs: string;
  readonly metrics: string;
};

export const parseEnvironmentName = Effect.fn("parseEnvironmentName")(function* (
  environment: string,
): Effect.fn.Return<string, RemoteEnvironmentError> {
  return yield* decodeEnvironmentName(environment).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentError({
          code: "OBS_CLI_REMOTE_INVALID_ENVIRONMENT",
          message:
            "The environment name is invalid. Use lowercase letters, digits and single dashes, with at most 32 characters.",
          cause,
        }),
    ),
  );
});

export const environmentDatasets = Effect.fn("environmentDatasets")(function* (
  project: string,
  environment: string,
): Effect.fn.Return<EnvironmentDatasets, RemoteEnvironmentError> {
  const names = {
    traces: `${project}-${environment}-traces`,
    logs: `${project}-${environment}-logs`,
    metrics: `${project}-${environment}-metrics`,
  };
  for (const name of [names.traces, names.logs, names.metrics]) {
    yield* decodeDatasetName(name).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteEnvironmentError({
            code: "OBS_CLI_REMOTE_INVALID_ENVIRONMENT",
            message:
              "The project and environment names produce a dataset name longer than 128 characters. Use shorter names.",
            cause,
          }),
      ),
    );
  }
  return names;
});

const requiredCredentials = (
  credentials: CredentialsFile,
): Effect.Effect<
  { readonly axiom: AxiomCredentials; readonly sentry: SentryCredentials },
  RemoteEnvironmentError
> => {
  if (credentials.axiom === undefined || credentials.sentry === undefined) {
    return Effect.fail(
      new RemoteEnvironmentError({
        code: "OBS_CLI_REMOTE_CREDENTIALS_MISSING",
        message:
          "Remote provisioning requires Axiom and Sentry credentials. Run observability auth login for both providers.",
        cause: "credentials",
      }),
    );
  }
  return Effect.succeed({ axiom: credentials.axiom, sentry: credentials.sentry });
};

const currentCredentials = Effect.fn("currentCredentials")(function* (
  store: CredentialsStore["Service"],
): Effect.fn.Return<CredentialsFile, CredentialsError> {
  const current = yield* store.load();
  return Option.getOrElse(current, emptyCredentials);
});

const makeCredentialsFile = (
  axiom: AxiomCredentials | undefined,
  sentry: SentryCredentials | undefined,
  environments: ReadonlyArray<ManagedEnvironment>,
): CredentialsFile => {
  if (axiom !== undefined && sentry !== undefined) {
    return new CredentialsFile({ version: 1, axiom, sentry, environments });
  }
  if (axiom !== undefined) {
    return new CredentialsFile({ version: 1, axiom, environments });
  }
  if (sentry !== undefined) {
    return new CredentialsFile({ version: 1, sentry, environments });
  }
  return new CredentialsFile({ version: 1, environments });
};

const replaceEnvironment = (
  credentials: CredentialsFile,
  environment: ManagedEnvironment,
): CredentialsFile =>
  makeCredentialsFile(credentials.axiom, credentials.sentry, [
    ...credentials.environments.filter(
      (candidate) =>
        candidate.project !== environment.project ||
        candidate.environment !== environment.environment,
    ),
    environment,
  ]);

export type AuthenticationStatus = {
  readonly axiom: string;
  readonly sentry: string;
  readonly credentialsPath: string;
};

export class Authentication extends Context.Service<
  Authentication,
  {
    loginAxiom(
      token: string,
      organizationId: string,
    ): Effect.Effect<string, CredentialsError | RemoteApiError>;
    loginSentry(
      token: string,
      organization: string,
      team: string,
      baseUrl: URL,
    ): Effect.Effect<string, CredentialsError | RemoteApiError>;
    status(): Effect.Effect<AuthenticationStatus, CredentialsError | RemoteApiError>;
  }
>()("@equipe-tech/observability-cli/Authentication") {
  static readonly layer = Layer.effect(
    Authentication,
    Effect.gen(function* () {
      const store = yield* CredentialsStore;
      const axiomApi = yield* AxiomApi;
      const sentryApi = yield* SentryApi;

      return Authentication.of({
        loginAxiom: Effect.fn("Authentication.loginAxiom")(function* (token, organizationId) {
          const credentials = new AxiomCredentials({ token, organizationId });
          const identity = yield* axiomApi.identity(credentials);
          const current = yield* currentCredentials(store);
          yield* store.save(makeCredentialsFile(credentials, current.sentry, current.environments));
          return identity;
        }),
        loginSentry: Effect.fn("Authentication.loginSentry")(
          function* (token, organization, team, baseUrl) {
            const credentials = new SentryCredentials({ token, organization, team, baseUrl });
            const identity = yield* sentryApi.identity(credentials);
            const current = yield* currentCredentials(store);
            yield* store.save(
              makeCredentialsFile(current.axiom, credentials, current.environments),
            );
            return identity;
          },
        ),
        status: Effect.fn("Authentication.status")(function* () {
          const current = yield* currentCredentials(store);
          const axiom =
            current.axiom === undefined
              ? "not authenticated"
              : yield* axiomApi.identity(current.axiom);
          const sentry =
            current.sentry === undefined
              ? "not authenticated"
              : yield* sentryApi.identity(current.sentry);
          return { axiom, sentry, credentialsPath: store.path };
        }),
      });
    }),
  );
}

export class RemoteEnvironment extends Context.Service<
  RemoteEnvironment,
  {
    provision(
      project: string,
      environments: ReadonlyArray<string>,
      platform: string,
      rotateToken: boolean,
    ): Effect.Effect<
      ReadonlyArray<ManagedEnvironment>,
      CredentialsError | RemoteApiError | RemoteEnvironmentError
    >;
    list(
      project: Option.Option<string>,
    ): Effect.Effect<ReadonlyArray<ManagedEnvironment>, CredentialsError>;
    export(
      project: string,
      environment: string,
    ): Effect.Effect<string, CredentialsError | RemoteEnvironmentError>;
  }
>()("@equipe-tech/observability-cli/RemoteEnvironment") {
  static readonly layer = Layer.effect(
    RemoteEnvironment,
    Effect.gen(function* () {
      const store = yield* CredentialsStore;
      const axiomApi = yield* AxiomApi;
      const sentryApi = yield* SentryApi;

      const list = Effect.fn("RemoteEnvironment.list")(function* (project: Option.Option<string>) {
        const credentials = yield* currentCredentials(store);
        return Option.match(project, {
          onNone: () => credentials.environments,
          onSome: (name) =>
            credentials.environments.filter((environment) => environment.project === name),
        });
      });

      return RemoteEnvironment.of({
        provision: Effect.fn("RemoteEnvironment.provision")(
          function* (project, environments, platform, rotateToken) {
            let credentials = yield* currentCredentials(store);
            const providers = yield* requiredCredentials(credentials);
            const existingDatasets = [...(yield* axiomApi.datasets(providers.axiom))];
            const existingTokens = [...(yield* axiomApi.tokens(providers.axiom))];
            const sentryProject = yield* sentryApi.ensureProject(
              providers.sentry,
              project,
              platform,
            );
            const sentryDsn = yield* sentryApi.dsn(providers.sentry, sentryProject);
            const provisioned: Array<ManagedEnvironment> = [];

            for (const rawEnvironment of environments) {
              const environment = yield* parseEnvironmentName(rawEnvironment);
              const datasets = yield* environmentDatasets(project, environment);
              const datasetNames = [datasets.traces, datasets.logs, datasets.metrics];
              for (const dataset of datasetNames) {
                if (!existingDatasets.includes(dataset)) {
                  yield* axiomApi.createDataset(providers.axiom, dataset);
                  existingDatasets.push(dataset);
                }
              }

              const tokenName = `${project}-${environment}-collector`;
              const remoteToken = existingTokens.find((token) => token.name === tokenName);
              const managed = credentials.environments.find(
                (candidate) =>
                  candidate.project === project && candidate.environment === environment,
              );
              let token: { readonly id: string; readonly token: string };
              if (rotateToken && remoteToken !== undefined) {
                token = yield* axiomApi.regenerateToken(providers.axiom, remoteToken.id);
              } else if (managed !== undefined && !rotateToken) {
                if (remoteToken === undefined || remoteToken.id !== managed.axiomTokenId) {
                  return yield* new RemoteEnvironmentError({
                    code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                    message: `The stored token for ${project}/${environment} does not match Axiom. Rerun with --rotate-token.`,
                    cause: tokenName,
                  });
                }
                token = { id: managed.axiomTokenId, token: managed.axiomToken };
              } else if (remoteToken !== undefined) {
                return yield* new RemoteEnvironmentError({
                  code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                  message: `Axiom already contains token ${tokenName}, but its secret is unavailable. Rerun with --rotate-token.`,
                  cause: tokenName,
                });
              } else {
                token = yield* axiomApi.createToken(providers.axiom, tokenName, datasetNames);
                existingTokens.push({ id: token.id, name: tokenName });
              }

              const result = new ManagedEnvironment({
                project,
                environment,
                axiomTokenId: token.id,
                axiomToken: token.token,
                tracesDataset: datasets.traces,
                logsDataset: datasets.logs,
                metricsDataset: datasets.metrics,
                sentryProject,
                sentryDsn,
              });
              credentials = replaceEnvironment(credentials, result);
              yield* store.save(credentials);
              provisioned.push(result);
            }
            return provisioned;
          },
        ),
        list,
        export: Effect.fn("RemoteEnvironment.export")(function* (project, rawEnvironment) {
          const environment = yield* parseEnvironmentName(rawEnvironment);
          const environments = yield* list(Option.some(project));
          const managed = environments.find((candidate) => candidate.environment === environment);
          if (managed === undefined) {
            return yield* new RemoteEnvironmentError({
              code: "OBS_CLI_REMOTE_ENVIRONMENT_NOT_FOUND",
              message: `Environment ${project}/${environment} is not configured. Run observability provision with --environment ${environment}.`,
              cause: `${project}/${environment}`,
            });
          }
          const variables = [
            ["OTEL_SERVICE_NAME", managed.project],
            ["OTEL_DEPLOYMENT_ENVIRONMENT", managed.environment],
            ["OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318"],
            ["AXIOM_TOKEN", managed.axiomToken],
            ["AXIOM_DATASET_TRACES", managed.tracesDataset],
            ["AXIOM_DATASET_LOGS", managed.logsDataset],
            ["AXIOM_DATASET_METRICS", managed.metricsDataset],
            ["SENTRY_DSN", managed.sentryDsn],
          ];
          return variables.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
        }),
      });
    }),
  );
}
