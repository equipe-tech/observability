import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  AxiomCredentials,
  AxiomEnvironment,
  CredentialsAccess,
  CredentialsError,
  CredentialsFile,
  CredentialsStore,
  emptyCredentials,
  ManagedEnvironment,
  PendingAxiomMutation,
  SentryCredentials,
  SentryEnvironment,
} from "./CredentialsStore.ts";
import { AxiomApi, RemoteApiError, SentryApi } from "./ProviderApis.ts";

const EnvironmentName = Schema.NonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    expected: "a lowercase environment name with letters, digits and single dashes",
  }),
);
const DatasetName = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const ProviderName = Schema.Literals(["axiom", "sentry"]);
const decodeEnvironmentName = Schema.decodeUnknownEffect(EnvironmentName);
const decodeDatasetName = Schema.decodeUnknownEffect(DatasetName);
const decodeProviderName = Schema.decodeUnknownEffect(ProviderName);

export type ProviderName = typeof ProviderName.Type;

export class RemoteEnvironmentError extends Schema.TaggedError<RemoteEnvironmentError>()(
  "RemoteEnvironmentError",
  {
    code: Schema.Literals([
      "OBS_CLI_REMOTE_CREDENTIALS_MISSING",
      "OBS_CLI_REMOTE_PROVIDER_CREDENTIALS_MISSING",
      "OBS_CLI_REMOTE_INVALID_PROVIDER",
      "OBS_CLI_REMOTE_INVALID_ENVIRONMENT",
      "OBS_CLI_REMOTE_ROTATION_NOT_SELECTED",
      "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
      "OBS_CLI_REMOTE_PARTIAL_FAILURE",
      "OBS_CLI_REMOTE_OUTCOME_UNKNOWN",
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

export const parseProviderSelection = Effect.fn("parseProviderSelection")(function* (
  providers: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ProviderName>, RemoteEnvironmentError> {
  const selected = new Set<ProviderName>();
  for (const provider of providers) {
    const parsed = yield* decodeProviderName(provider).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteEnvironmentError({
            code: "OBS_CLI_REMOTE_INVALID_PROVIDER",
            message: `Provider ${provider} is invalid. Use axiom or sentry.`,
            cause,
          }),
      ),
    );
    selected.add(parsed);
  }
  const canonicalProviders: ReadonlyArray<ProviderName> = ["axiom", "sentry"];
  return canonicalProviders.filter((provider) => selected.has(provider));
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

export const validateRemoteProvisionRequest = Effect.fn("validateRemoteProvisionRequest")(
  function* (
    project: string,
    environments: ReadonlyArray<string>,
  ): Effect.fn.Return<void, RemoteEnvironmentError> {
    for (const rawEnvironment of environments) {
      const environment = yield* parseEnvironmentName(rawEnvironment);
      yield* environmentDatasets(project, environment);
    }
  },
);

export const environmentAxiom = (
  environment: ManagedEnvironment,
): Option.Option<AxiomEnvironment> => {
  if (environment.providers.type === "sentry") {
    return Option.none();
  }
  return Option.some(environment.providers.axiom);
};

export const environmentSentry = (
  environment: ManagedEnvironment,
): Option.Option<SentryEnvironment> => {
  if (environment.providers.type === "axiom") {
    return Option.none();
  }
  return Option.some(environment.providers.sentry);
};

export const environmentProviderNames = (
  environment: ManagedEnvironment,
): ReadonlyArray<ProviderName> => {
  if (environment.providers.type === "axiom") {
    return ["axiom"];
  }
  if (environment.providers.type === "sentry") {
    return ["sentry"];
  }
  return ["axiom", "sentry"];
};

const makeProviders = (
  axiom: Option.Option<AxiomEnvironment>,
  sentry: Option.Option<SentryEnvironment>,
): Effect.Effect<ManagedEnvironment["providers"], CredentialsError> => {
  if (Option.isSome(axiom) && Option.isSome(sentry)) {
    return Effect.succeed({ type: "combined", axiom: axiom.value, sentry: sentry.value });
  }
  if (Option.isSome(axiom)) {
    return Effect.succeed({ type: "axiom", axiom: axiom.value });
  }
  if (Option.isSome(sentry)) {
    return Effect.succeed({ type: "sentry", sentry: sentry.value });
  }
  return Effect.fail(
    new CredentialsError({
      code: "OBS_CLI_CREDENTIALS_INVALID",
      message: "The credentials file contains an environment without a provider.",
      cause: "empty-environment-providers",
    }),
  );
};

const makeCredentialsFile = (
  axiom: AxiomCredentials | undefined,
  sentry: SentryCredentials | undefined,
  environments: ReadonlyArray<ManagedEnvironment>,
  pendingAxiomMutations: ReadonlyArray<PendingAxiomMutation> = [],
): CredentialsFile => {
  if (pendingAxiomMutations.length > 0) {
    if (axiom !== undefined && sentry !== undefined) {
      return new CredentialsFile({
        version: 2,
        axiom,
        sentry,
        environments,
        pendingAxiomMutations,
      });
    }
    if (axiom !== undefined) {
      return new CredentialsFile({ version: 2, axiom, environments, pendingAxiomMutations });
    }
    if (sentry !== undefined) {
      return new CredentialsFile({ version: 2, sentry, environments, pendingAxiomMutations });
    }
    return new CredentialsFile({ version: 2, environments, pendingAxiomMutations });
  }
  if (axiom !== undefined && sentry !== undefined) {
    return new CredentialsFile({ version: 2, axiom, sentry, environments });
  }
  if (axiom !== undefined) {
    return new CredentialsFile({ version: 2, axiom, environments });
  }
  if (sentry !== undefined) {
    return new CredentialsFile({ version: 2, sentry, environments });
  }
  return new CredentialsFile({ version: 2, environments });
};

const pendingAxiomMutations = (credentials: CredentialsFile): ReadonlyArray<PendingAxiomMutation> =>
  credentials.pendingAxiomMutations ?? [];

const hasPendingAxiomMutation = (
  credentials: CredentialsFile,
  project: string,
  environment: string,
): boolean =>
  pendingAxiomMutations(credentials).some(
    (pending) => pending.project === project && pending.environment === environment,
  );

const markAxiomMutationPending = (
  credentials: CredentialsFile,
  project: string,
  environment: string,
): CredentialsFile =>
  makeCredentialsFile(credentials.axiom, credentials.sentry, credentials.environments, [
    ...pendingAxiomMutations(credentials).filter(
      (pending) => pending.project !== project || pending.environment !== environment,
    ),
    new PendingAxiomMutation({ project, environment }),
  ]);

const clearPendingAxiomMutation = (
  credentials: CredentialsFile,
  project: string,
  environment: string,
): CredentialsFile =>
  makeCredentialsFile(
    credentials.axiom,
    credentials.sentry,
    credentials.environments,
    pendingAxiomMutations(credentials).filter(
      (pending) => pending.project !== project || pending.environment !== environment,
    ),
  );

const replaceEnvironment = (
  credentials: CredentialsFile,
  environment: ManagedEnvironment,
): CredentialsFile =>
  makeCredentialsFile(
    credentials.axiom,
    credentials.sentry,
    [
      ...credentials.environments.filter(
        (candidate) =>
          candidate.project !== environment.project ||
          candidate.environment !== environment.environment,
      ),
      environment,
    ],
    pendingAxiomMutations(credentials),
  );

const currentCredentials = Effect.fn("currentCredentials")(function* (
  access: CredentialsAccess,
): Effect.fn.Return<CredentialsFile, CredentialsError> {
  const current = yield* access.load();
  return Option.getOrElse(current, emptyCredentials);
});

const existingEnvironment = (
  credentials: CredentialsFile,
  project: string,
  environment: string,
): Option.Option<ManagedEnvironment> =>
  Option.fromNullishOr(
    credentials.environments.find(
      (candidate) => candidate.project === project && candidate.environment === environment,
    ),
  );

const effectiveProviders = (
  explicit: ReadonlyArray<ProviderName>,
  existing: Option.Option<ManagedEnvironment>,
): ReadonlyArray<ProviderName> => {
  if (explicit.length > 0) {
    return explicit;
  }
  if (Option.isSome(existing)) {
    return environmentProviderNames(existing.value);
  }
  return ["axiom", "sentry"];
};

type RequestedEnvironment = {
  readonly name: string;
  readonly datasets: EnvironmentDatasets;
  readonly existing: Option.Option<ManagedEnvironment>;
  readonly providers: ReadonlyArray<ProviderName>;
};

const requireCredentials = Effect.fn("requireCredentials")(function* (
  credentials: CredentialsFile,
  providers: ReadonlySet<ProviderName>,
): Effect.fn.Return<
  {
    readonly axiom: Option.Option<AxiomCredentials>;
    readonly sentry: Option.Option<SentryCredentials>;
  },
  RemoteEnvironmentError
> {
  const axiom = Option.fromNullishOr(credentials.axiom);
  const sentry = Option.fromNullishOr(credentials.sentry);
  if (
    providers.has("axiom") &&
    providers.has("sentry") &&
    Option.isNone(axiom) &&
    Option.isNone(sentry)
  ) {
    return yield* new RemoteEnvironmentError({
      code: "OBS_CLI_REMOTE_CREDENTIALS_MISSING",
      message:
        "Remote provisioning requires Axiom and Sentry credentials. Run observability auth login for both providers.",
      cause: "axiom,sentry",
    });
  }
  if (providers.has("axiom") && Option.isNone(axiom)) {
    return yield* new RemoteEnvironmentError({
      code: "OBS_CLI_REMOTE_PROVIDER_CREDENTIALS_MISSING",
      message:
        "Axiom credentials are required. Run observability auth login axiom --organization-id <organization-id>.",
      cause: "axiom",
    });
  }
  if (providers.has("sentry") && Option.isNone(sentry)) {
    return yield* new RemoteEnvironmentError({
      code: "OBS_CLI_REMOTE_PROVIDER_CREDENTIALS_MISSING",
      message:
        "Sentry credentials are required. Run observability auth login sentry --organization <organization> --team <team>.",
      cause: "sentry",
    });
  }
  return { axiom, sentry };
});

const partialFailure = (
  error: RemoteApiError,
  completed: ReadonlyArray<string>,
): RemoteApiError | RemoteEnvironmentError => {
  if (completed.length === 0) {
    return error;
  }
  return new RemoteEnvironmentError({
    code: "OBS_CLI_REMOTE_PARTIAL_FAILURE",
    message: `${error.provider} failed after these environments were saved: ${completed.join(", ")}. Retry the command.`,
    cause: error,
  });
};

const mutationOutcomeUnknown = (
  error: RemoteApiError,
  completed: ReadonlyArray<string>,
): RemoteApiError | RemoteEnvironmentError => {
  if (error.status > 0 && error.status < 500 && error.code !== "OBS_CLI_REMOTE_INVALID_RESPONSE") {
    return partialFailure(error, completed);
  }
  const completedText = completed.length === 0 ? "none" : completed.join(", ");
  return new RemoteEnvironmentError({
    code: "OBS_CLI_REMOTE_OUTCOME_UNKNOWN",
    message: `The Axiom token outcome is unknown. Rotate the token before retrying. Saved environments: ${completedText}.`,
    cause: error,
  });
};

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
          yield* store.exclusive((access) =>
            Effect.gen(function* () {
              const current = yield* currentCredentials(access);
              yield* access.save(
                makeCredentialsFile(
                  credentials,
                  current.sentry,
                  current.environments,
                  pendingAxiomMutations(current),
                ),
              );
            }),
          );
          return identity;
        }),
        loginSentry: Effect.fn("Authentication.loginSentry")(
          function* (token, organization, team, baseUrl) {
            const credentials = new SentryCredentials({ token, organization, team, baseUrl });
            const identity = yield* sentryApi.identity(credentials);
            yield* store.exclusive((access) =>
              Effect.gen(function* () {
                const current = yield* currentCredentials(access);
                yield* access.save(
                  makeCredentialsFile(
                    current.axiom,
                    credentials,
                    current.environments,
                    pendingAxiomMutations(current),
                  ),
                );
              }),
            );
            return identity;
          },
        ),
        status: Effect.fn("Authentication.status")(function* () {
          const current = Option.getOrElse(yield* store.load(), emptyCredentials);
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
      providers: ReadonlyArray<ProviderName>,
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
        const credentials = Option.getOrElse(yield* store.load(), emptyCredentials);
        return Option.match(project, {
          onNone: () => credentials.environments,
          onSome: (name) =>
            credentials.environments.filter((environment) => environment.project === name),
        });
      });

      return RemoteEnvironment.of({
        provision: Effect.fn("RemoteEnvironment.provision")(
          function* (
            project,
            environments,
            explicitProviders,
            platform,
            rotateToken,
          ): Effect.fn.Return<
            ReadonlyArray<ManagedEnvironment>,
            CredentialsError | RemoteApiError | RemoteEnvironmentError
          > {
            const validated: Array<{
              readonly name: string;
              readonly datasets: EnvironmentDatasets;
            }> = [];
            for (const rawEnvironment of environments) {
              const name = yield* parseEnvironmentName(rawEnvironment);
              validated.push({ name, datasets: yield* environmentDatasets(project, name) });
            }
            return yield* store.exclusive((access) =>
              Effect.gen(function* () {
                let credentials = yield* currentCredentials(access);
                const requested: Array<RequestedEnvironment> = [];
                for (const environment of validated) {
                  const existing = existingEnvironment(credentials, project, environment.name);
                  requested.push({
                    name: environment.name,
                    datasets: environment.datasets,
                    existing,
                    providers: effectiveProviders(explicitProviders, existing),
                  });
                }
                if (
                  rotateToken &&
                  requested.some((environment) => !environment.providers.includes("axiom"))
                ) {
                  return yield* new RemoteEnvironmentError({
                    code: "OBS_CLI_REMOTE_ROTATION_NOT_SELECTED",
                    message:
                      "Token rotation requires Axiom for every requested environment. Select --provider axiom or remove --rotate-token.",
                    cause: "rotate-token",
                  });
                }
                if (
                  !rotateToken &&
                  requested.some(
                    (environment) =>
                      environment.providers.includes("axiom") &&
                      hasPendingAxiomMutation(credentials, project, environment.name),
                  )
                ) {
                  return yield* new RemoteEnvironmentError({
                    code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                    message:
                      "A previous Axiom token mutation did not reach a durable checkpoint. Rerun with --rotate-token.",
                    cause: "pending-axiom-mutation",
                  });
                }

                const selected = new Set(requested.flatMap((environment) => environment.providers));
                const providerCredentials = yield* requireCredentials(credentials, selected);
                const axiomCredentials = providerCredentials.axiom;
                const sentryCredentials = providerCredentials.sentry;

                let sentry = Option.none<SentryEnvironment>();
                if (selected.has("sentry") && Option.isSome(sentryCredentials)) {
                  const sentryProject = yield* sentryApi.ensureProject(
                    sentryCredentials.value,
                    project,
                    platform,
                  );
                  const sentryDsn = yield* sentryApi.dsn(sentryCredentials.value, sentryProject);
                  sentry = Option.some(
                    new SentryEnvironment({ project: sentryProject, dsn: sentryDsn }),
                  );
                }

                const existingDatasets =
                  selected.has("axiom") && Option.isSome(axiomCredentials)
                    ? [...(yield* axiomApi.datasets(axiomCredentials.value))]
                    : [];
                const existingTokens =
                  selected.has("axiom") && Option.isSome(axiomCredentials)
                    ? [...(yield* axiomApi.tokens(axiomCredentials.value))]
                    : [];
                const completed: Array<string> = [];
                const provisioned: Array<ManagedEnvironment> = [];

                for (const request of requested) {
                  const checkpoint: Effect.Effect<
                    ManagedEnvironment,
                    CredentialsError | RemoteApiError | RemoteEnvironmentError
                  > = Effect.gen(function* () {
                    let axiom = Option.isSome(request.existing)
                      ? environmentAxiom(request.existing.value)
                      : Option.none<AxiomEnvironment>();
                    let selectedSentry = Option.isSome(request.existing)
                      ? environmentSentry(request.existing.value)
                      : Option.none<SentryEnvironment>();
                    if (request.providers.includes("sentry")) {
                      selectedSentry = sentry;
                    }

                    let tokenMutated = false;
                    if (request.providers.includes("axiom") && Option.isSome(axiomCredentials)) {
                      const datasetNames = [
                        request.datasets.traces,
                        request.datasets.logs,
                        request.datasets.metrics,
                      ];
                      for (const dataset of datasetNames) {
                        if (!existingDatasets.includes(dataset)) {
                          yield* axiomApi.createDataset(axiomCredentials.value, dataset);
                          existingDatasets.push(dataset);
                        }
                      }

                      const tokenName = `${project}-${request.name}-collector`;
                      const remoteToken = existingTokens.find((token) => token.name === tokenName);
                      const localAxiom = Option.isSome(request.existing)
                        ? environmentAxiom(request.existing.value)
                        : Option.none<AxiomEnvironment>();
                      let token: { readonly id: string; readonly token: string };
                      if (rotateToken) {
                        tokenMutated = true;
                        credentials = markAxiomMutationPending(credentials, project, request.name);
                        yield* access.save(credentials);
                        token = yield* (
                          remoteToken === undefined
                            ? axiomApi.createToken(axiomCredentials.value, tokenName, datasetNames)
                            : axiomApi.regenerateToken(axiomCredentials.value, remoteToken.id)
                        ).pipe(
                          Effect.catchTag("RemoteApiError", (error) => {
                            const classified = mutationOutcomeUnknown(error, completed);
                            if (
                              classified._tag === "RemoteEnvironmentError" &&
                              classified.code === "OBS_CLI_REMOTE_OUTCOME_UNKNOWN"
                            ) {
                              return Effect.fail(classified);
                            }
                            credentials = clearPendingAxiomMutation(
                              credentials,
                              project,
                              request.name,
                            );
                            return access
                              .save(credentials)
                              .pipe(Effect.andThen(Effect.fail(classified)));
                          }),
                        );
                        if (remoteToken === undefined) {
                          existingTokens.push({ id: token.id, name: tokenName });
                        }
                      } else if (Option.isSome(localAxiom)) {
                        if (
                          remoteToken === undefined ||
                          remoteToken.id !== localAxiom.value.tokenId
                        ) {
                          return yield* new RemoteEnvironmentError({
                            code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                            message: `The stored token for ${project}/${request.name} does not match Axiom. Rerun with --rotate-token.`,
                            cause: tokenName,
                          });
                        }
                        token = { id: localAxiom.value.tokenId, token: localAxiom.value.token };
                      } else if (remoteToken !== undefined) {
                        return yield* new RemoteEnvironmentError({
                          code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                          message: `Axiom already contains token ${tokenName}, but its secret is unavailable. Rerun with --rotate-token.`,
                          cause: tokenName,
                        });
                      } else {
                        tokenMutated = true;
                        credentials = markAxiomMutationPending(credentials, project, request.name);
                        yield* access.save(credentials);
                        token = yield* axiomApi
                          .createToken(axiomCredentials.value, tokenName, datasetNames)
                          .pipe(
                            Effect.catchTag("RemoteApiError", (error) => {
                              const classified = mutationOutcomeUnknown(error, completed);
                              if (
                                classified._tag === "RemoteEnvironmentError" &&
                                classified.code === "OBS_CLI_REMOTE_OUTCOME_UNKNOWN"
                              ) {
                                return Effect.fail(classified);
                              }
                              credentials = clearPendingAxiomMutation(
                                credentials,
                                project,
                                request.name,
                              );
                              return access
                                .save(credentials)
                                .pipe(Effect.andThen(Effect.fail(classified)));
                            }),
                          );
                        existingTokens.push({ id: token.id, name: tokenName });
                      }
                      axiom = Option.some(
                        new AxiomEnvironment({
                          tokenId: token.id,
                          token: token.token,
                          tracesDataset: request.datasets.traces,
                          logsDataset: request.datasets.logs,
                          metricsDataset: request.datasets.metrics,
                        }),
                      );
                    }

                    const environment = new ManagedEnvironment({
                      project,
                      environment: request.name,
                      providers: yield* makeProviders(axiom, selectedSentry),
                    });
                    credentials = replaceEnvironment(credentials, environment);
                    if (tokenMutated) {
                      credentials = clearPendingAxiomMutation(credentials, project, request.name);
                      yield* access.save(credentials).pipe(
                        Effect.mapError(
                          (error) =>
                            new RemoteEnvironmentError({
                              code: "OBS_CLI_REMOTE_OUTCOME_UNKNOWN",
                              message: `The Axiom token changed, but local state could not be saved. Rotate the token before retrying. Saved environments: ${completed.length === 0 ? "none" : completed.join(", ")}.`,
                              cause: error,
                            }),
                        ),
                      );
                    } else {
                      yield* access.save(credentials);
                    }
                    completed.push(`${project}/${request.name}`);
                    return environment;
                  });
                  const result = yield* checkpoint.pipe(
                    Effect.catchTag("RemoteApiError", (error) =>
                      Effect.fail(partialFailure(error, completed)),
                    ),
                  );
                  provisioned.push(result);
                }
                return provisioned;
              }),
            );
          },
        ),
        list,
        export: Effect.fn("RemoteEnvironment.export")(function* (project, rawEnvironment) {
          const environment = yield* parseEnvironmentName(rawEnvironment);
          const credentials = Option.getOrElse(yield* store.load(), emptyCredentials);
          const managed = credentials.environments.find(
            (candidate) => candidate.project === project && candidate.environment === environment,
          );
          if (managed === undefined) {
            return yield* new RemoteEnvironmentError({
              code: "OBS_CLI_REMOTE_ENVIRONMENT_NOT_FOUND",
              message: `Environment ${project}/${environment} is not configured. Run observability provision with --environment ${environment}.`,
              cause: `${project}/${environment}`,
            });
          }
          if (
            hasPendingAxiomMutation(credentials, project, environment) &&
            Option.isSome(environmentAxiom(managed))
          ) {
            return yield* new RemoteEnvironmentError({
              code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
              message: `The stored token for ${project}/${environment} may be stale after an unresolved mutation. Rerun provisioning with --provider axiom --rotate-token before exporting it.`,
              cause: `${project}/${environment}`,
            });
          }
          const variables: Array<readonly [string, string]> = [
            ["OTEL_SERVICE_NAME", managed.project],
            ["OTEL_DEPLOYMENT_ENVIRONMENT", managed.environment],
          ];
          const axiom = environmentAxiom(managed);
          if (Option.isSome(axiom)) {
            variables.push(
              ["OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318"],
              ["AXIOM_TOKEN", axiom.value.token],
              ["AXIOM_DATASET_TRACES", axiom.value.tracesDataset],
              ["AXIOM_DATASET_LOGS", axiom.value.logsDataset],
              ["AXIOM_DATASET_METRICS", axiom.value.metricsDataset],
            );
          }
          const sentry = environmentSentry(managed);
          if (Option.isSome(sentry)) {
            variables.push(["SENTRY_DSN", sentry.value.dsn]);
          }
          return variables.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
        }),
      });
    }),
  );
}
