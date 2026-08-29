import { EnvironmentName, ServiceName } from "@equipe-tech/observability";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
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
  VerifiedAxiomDataset,
  SentryEnvironment,
} from "./CredentialsStore.ts";
import {
  AxiomApi,
  AxiomDataset,
  AxiomDatasetCreateOptions,
  AxiomToken,
  RemoteApiError,
  SentryApi,
} from "./ProviderApis.ts";

const DatasetName = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const ProviderName = Schema.Literals(["axiom", "sentry"]);
const decodeServiceName = Schema.decodeUnknownEffect(ServiceName);
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
      "OBS_CLI_REMOTE_INVALID_PROJECT",
      "OBS_CLI_REMOTE_INVALID_ENVIRONMENT",
      "OBS_CLI_REMOTE_ROTATION_NOT_SELECTED",
      "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
      "OBS_CLI_REMOTE_PARTIAL_FAILURE",
      "OBS_CLI_REMOTE_OUTCOME_UNKNOWN",
      "OBS_CLI_REMOTE_ENVIRONMENT_NOT_FOUND",
      "OBS_CLI_AXIOM_METRICS_MIGRATION_REQUIRED",
      "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
      "OBS_CLI_AXIOM_REMOTE_NAME_CONFLICT",
      "OBS_CLI_AXIOM_TOKEN_CAPABILITIES_MISMATCH",
      "OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED",
      "OBS_CLI_AXIOM_RETENTION_INVALID",
    ]),
    message: Schema.String,
    datasetName: Schema.NonEmptyString.pipe(Schema.optionalKey),
    actualKind: Schema.NonEmptyString.pipe(Schema.optionalKey),
    requiredKind: Schema.NonEmptyString.pipe(Schema.optionalKey),
    project: Schema.NonEmptyString.pipe(Schema.optionalKey),
    environment: Schema.NonEmptyString.pipe(Schema.optionalKey),
    cause: Schema.Defect(),
  },
) {}

export type EnvironmentDatasets = {
  readonly traces: string;
  readonly logs: string;
  readonly metrics: string;
};

const parseServiceName = Effect.fn("parseServiceName")(function* (
  service: string,
): Effect.fn.Return<string, RemoteEnvironmentError> {
  return yield* decodeServiceName(service).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentError({
          code: "OBS_CLI_REMOTE_INVALID_PROJECT",
          message:
            "The project name is invalid. Use lowercase letters, digits and single hyphens between segments, with at most 63 characters.",
          cause,
        }),
    ),
  );
});

export const parseEnvironmentName = Effect.fn("parseEnvironmentName")(function* (
  environment: string,
): Effect.fn.Return<string, RemoteEnvironmentError> {
  return yield* decodeEnvironmentName(environment).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentError({
          code: "OBS_CLI_REMOTE_INVALID_ENVIRONMENT",
          message:
            "The environment name is invalid. Use lowercase letters, digits and single hyphens between segments, with at most 32 characters.",
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
        version: 3,
        axiom,
        sentry,
        environments,
        pendingAxiomMutations,
      });
    }
    if (axiom !== undefined) {
      return new CredentialsFile({ version: 3, axiom, environments, pendingAxiomMutations });
    }
    if (sentry !== undefined) {
      return new CredentialsFile({ version: 3, sentry, environments, pendingAxiomMutations });
    }
    return new CredentialsFile({ version: 3, environments, pendingAxiomMutations });
  }
  if (axiom !== undefined && sentry !== undefined) {
    return new CredentialsFile({ version: 3, axiom, sentry, environments });
  }
  if (axiom !== undefined) {
    return new CredentialsFile({ version: 3, axiom, environments });
  }
  if (sentry !== undefined) {
    return new CredentialsFile({ version: 3, sentry, environments });
  }
  return new CredentialsFile({ version: 3, environments });
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

const expectedDatasetCapabilities = (
  token: AxiomToken,
  datasets: ReadonlyArray<string>,
): boolean => {
  const capabilityNames = Object.keys(token.datasetCapabilities);
  if (capabilityNames.length !== datasets.length) {
    return false;
  }
  if (
    Object.keys(token.orgCapabilities).length !== 0 ||
    Object.keys(token.viewCapabilities).length !== 0
  ) {
    return false;
  }
  return datasets.every((dataset) => {
    const capability = token.datasetCapabilities[dataset];
    if (capability === undefined || Object.keys(capability).length !== 1) {
      return false;
    }
    return capability.ingest?.length === 1 && capability.ingest[0] === "create";
  });
};

const matchingManualCorrelation = (
  existing: Option.Option<ManagedEnvironment>,
  project: string,
  environment: string,
  datasets: EnvironmentDatasets,
): boolean => {
  if (Option.isNone(existing)) {
    return false;
  }
  const axiom = environmentAxiom(existing.value);
  if (Option.isNone(axiom) || axiom.value.correlation.type !== "manual-required") {
    return false;
  }
  const correlation = axiom.value.correlation;
  return (
    correlation.groupName === `${project} ${environment}` &&
    correlation.groupSlug === `${project}-${environment}` &&
    correlation.tracesDataset === datasets.traces &&
    correlation.logsDataset === datasets.logs &&
    correlation.metricsDataset === datasets.metrics
  );
};

const verifiedDataset = (dataset: AxiomDataset): VerifiedAxiomDataset => {
  const common = {
    id: dataset.id,
    name: dataset.name,
    kind: dataset.kind,
    useRetentionPeriod: dataset.useRetentionPeriod,
  };
  if (dataset.edgeDeployment !== undefined && dataset.retentionDays !== undefined) {
    return new VerifiedAxiomDataset({
      ...common,
      edgeDeployment: dataset.edgeDeployment,
      retentionDays: dataset.retentionDays,
    });
  }
  if (dataset.edgeDeployment !== undefined) {
    return new VerifiedAxiomDataset({ ...common, edgeDeployment: dataset.edgeDeployment });
  }
  if (dataset.retentionDays !== undefined) {
    return new VerifiedAxiomDataset({ ...common, retentionDays: dataset.retentionDays });
  }
  return new VerifiedAxiomDataset(common);
};

const mutationOutcomeUnknown = (
  error: RemoteApiError,
  completed: ReadonlyArray<string>,
): RemoteApiError | RemoteEnvironmentError => {
  if (
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== "OBS_CLI_REMOTE_INVALID_RESPONSE"
  ) {
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
      axiomEdgeDeployment?: string,
      axiomRetentionDays?: number,
      correlationConfirmed?: boolean,
    ): Effect.Effect<
      ReadonlyArray<ManagedEnvironment>,
      CredentialsError | RemoteApiError | RemoteEnvironmentError
    >;
    list(
      project: Option.Option<string>,
    ): Effect.Effect<ReadonlyArray<ManagedEnvironment>, CredentialsError | RemoteEnvironmentError>;
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
        const name = yield* Option.match(project, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (rawName) => parseServiceName(rawName).pipe(Effect.map(Option.some)),
        });
        const credentials = Option.getOrElse(yield* store.load(), emptyCredentials);
        return Option.match(name, {
          onNone: () => credentials.environments,
          onSome: (validatedName) =>
            credentials.environments.filter((environment) => environment.project === validatedName),
        });
      });

      return RemoteEnvironment.of({
        provision: Effect.fn("RemoteEnvironment.provision")(function* (
          project,
          environments,
          explicitProviders,
          platform,
          rotateToken,
          axiomEdgeDeployment,
          axiomRetentionDays,
          correlationConfirmed = false,
        ): Effect.fn.Return<
          ReadonlyArray<ManagedEnvironment>,
          CredentialsError | RemoteApiError | RemoteEnvironmentError
        > {
          if (
            axiomRetentionDays !== undefined &&
            (!Number.isInteger(axiomRetentionDays) || axiomRetentionDays <= 0)
          ) {
            return yield* new RemoteEnvironmentError({
              code: "OBS_CLI_AXIOM_RETENTION_INVALID",
              message: "Axiom retention days must be a positive integer.",
              cause: axiomRetentionDays,
            });
          }
          if (axiomEdgeDeployment !== undefined && axiomEdgeDeployment.length === 0) {
            return yield* new RemoteEnvironmentError({
              code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
              message: "The Axiom edge deployment identifier must not be empty.",
              cause: axiomEdgeDeployment,
            });
          }
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
              if (correlationConfirmed) {
                if (axiomEdgeDeployment === undefined) {
                  return yield* new RemoteEnvironmentError({
                    code: "OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED",
                    message:
                      "Correlation confirmation requires one explicit --axiom-edge-deployment value.",
                    cause: "missing-axiom-edge-deployment",
                  });
                }
                for (const request of requested) {
                  if (
                    !request.providers.includes("axiom") ||
                    !matchingManualCorrelation(
                      request.existing,
                      project,
                      request.name,
                      request.datasets,
                    )
                  ) {
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED",
                      message: `Correlation for ${project}/${request.name} can be confirmed only after a prior completed provisioning invocation saved the matching manual action.`,
                      cause: `${project}/${request.name}`,
                    });
                  }
                }
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
              const existingDatasets =
                selected.has("axiom") && Option.isSome(axiomCredentials)
                  ? [...(yield* axiomApi.datasets(axiomCredentials.value))]
                  : [];
              const existingTokens =
                selected.has("axiom") && Option.isSome(axiomCredentials)
                  ? [...(yield* axiomApi.tokens(axiomCredentials.value))]
                  : [];

              for (const request of requested) {
                if (!request.providers.includes("axiom")) {
                  continue;
                }
                const desiredDatasets = [
                  { name: request.datasets.traces, kind: "axiom:events:v1" },
                  { name: request.datasets.logs, kind: "axiom:events:v1" },
                  { name: request.datasets.metrics, kind: "otel:metrics:v1" },
                ];
                for (const desired of desiredDatasets) {
                  const matches = existingDatasets.filter(
                    (dataset) => dataset.name === desired.name,
                  );
                  if (matches.length > 1) {
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_AXIOM_REMOTE_NAME_CONFLICT",
                      message: `Axiom contains multiple datasets named ${desired.name}. Resolve the duplicate names before retrying.`,
                      cause: desired.name,
                    });
                  }
                  const match = matches[0];
                  if (match === undefined) {
                    if (correlationConfirmed) {
                      return yield* new RemoteEnvironmentError({
                        code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                        message: `Axiom dataset ${desired.name} is missing. Restore it and complete provisioning before confirming correlation.`,
                        cause: desired.name,
                      });
                    }
                    continue;
                  }
                  if (match.kind !== desired.kind) {
                    if (desired.name === request.datasets.metrics) {
                      return yield* new RemoteEnvironmentError({
                        code: "OBS_CLI_AXIOM_METRICS_MIGRATION_REQUIRED",
                        message: `Axiom metrics dataset ${desired.name} has kind ${match.kind}, but ${desired.kind} is required. Preserve historical metrics, stop ingestion, and replace the dataset manually before retrying.`,
                        datasetName: desired.name,
                        actualKind: match.kind,
                        requiredKind: desired.kind,
                        project,
                        environment: request.name,
                        cause: `${project}/${request.name}`,
                      });
                    }
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                      message: `Axiom dataset ${desired.name} has incompatible kind ${match.kind}. Review the dataset before retrying.`,
                      cause: desired.name,
                    });
                  }
                  if (
                    axiomRetentionDays !== undefined &&
                    (!match.useRetentionPeriod || match.retentionDays !== axiomRetentionDays)
                  ) {
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                      message: `Axiom dataset ${desired.name} has retention that differs from the explicitly requested ${axiomRetentionDays} days. Retention changes are destructive and must be performed manually before retrying.`,
                      cause: desired.name,
                    });
                  }
                  if (
                    axiomEdgeDeployment !== undefined &&
                    match.edgeDeployment !== axiomEdgeDeployment
                  ) {
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                      message: `Axiom dataset ${desired.name} does not use edge deployment ${axiomEdgeDeployment}. Reconcile the edge deployment in Axiom before retrying.`,
                      cause: desired.name,
                    });
                  }
                }

                const tokenName = `${project}-${request.name}-collector`;
                const namedTokens = existingTokens.filter((token) => token.name === tokenName);
                if (namedTokens.length > 1) {
                  return yield* new RemoteEnvironmentError({
                    code: "OBS_CLI_AXIOM_REMOTE_NAME_CONFLICT",
                    message: `Axiom contains multiple tokens named ${tokenName}. Resolve the duplicate names before retrying.`,
                    cause: tokenName,
                  });
                }
                const remoteToken = namedTokens[0];
                const localAxiom = Option.isSome(request.existing)
                  ? environmentAxiom(request.existing.value)
                  : Option.none<AxiomEnvironment>();
                const datasetNames = [
                  request.datasets.traces,
                  request.datasets.logs,
                  request.datasets.metrics,
                ];
                if (!rotateToken && remoteToken !== undefined) {
                  if (!expectedDatasetCapabilities(remoteToken, datasetNames)) {
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_AXIOM_TOKEN_CAPABILITIES_MISMATCH",
                      message: `Axiom token ${tokenName} does not have exact ingest-create access to the three environment datasets. Rerun with --rotate-token.`,
                      cause: tokenName,
                    });
                  }
                  if (Option.isNone(localAxiom) || localAxiom.value.tokenId !== remoteToken.id) {
                    return yield* new RemoteEnvironmentError({
                      code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                      message: `Axiom already contains token ${tokenName}, but its matching local secret is unavailable. Rerun with --rotate-token.`,
                      cause: tokenName,
                    });
                  }
                }
                if (!rotateToken && remoteToken === undefined && Option.isSome(localAxiom)) {
                  return yield* new RemoteEnvironmentError({
                    code: "OBS_CLI_REMOTE_TOKEN_UNAVAILABLE",
                    message: `The stored token for ${project}/${request.name} does not match Axiom. Rerun with --rotate-token.`,
                    cause: tokenName,
                  });
                }
              }

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
                    const desiredDatasets: ReadonlyArray<{
                      readonly name: string;
                      readonly kind: "axiom:events:v1" | "otel:metrics:v1";
                    }> = [
                      { name: request.datasets.traces, kind: "axiom:events:v1" },
                      { name: request.datasets.logs, kind: "axiom:events:v1" },
                      { name: request.datasets.metrics, kind: "otel:metrics:v1" },
                    ];
                    const reconciledDatasets: Array<AxiomDataset> = [];
                    for (const desired of desiredDatasets) {
                      let dataset = existingDatasets.find(
                        (candidate) => candidate.name === desired.name,
                      );
                      if (dataset === undefined) {
                        const options: AxiomDatasetCreateOptions =
                          axiomEdgeDeployment === undefined
                            ? axiomRetentionDays === undefined
                              ? { kind: desired.kind }
                              : { kind: desired.kind, retentionDays: axiomRetentionDays }
                            : axiomRetentionDays === undefined
                              ? { kind: desired.kind, edgeDeployment: axiomEdgeDeployment }
                              : {
                                  kind: desired.kind,
                                  edgeDeployment: axiomEdgeDeployment,
                                  retentionDays: axiomRetentionDays,
                                };
                        dataset = yield* axiomApi.createDataset(
                          axiomCredentials.value,
                          desired.name,
                          options,
                        );
                        existingDatasets.push(dataset);
                      }
                      reconciledDatasets.push(dataset);
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
                          : axiomApi.regenerateToken(
                              axiomCredentials.value,
                              remoteToken,
                              datasetNames,
                            )
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
                    }
                    let verified = reconciledDatasets;
                    if (correlationConfirmed) {
                      verified = [...(yield* axiomApi.datasets(axiomCredentials.value))].filter(
                        (dataset) => datasetNames.includes(dataset.name),
                      );
                      if (verified.length !== 3) {
                        return yield* new RemoteEnvironmentError({
                          code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                          message: `A fresh Axiom verification could not find all three datasets for ${project}/${request.name}. Retry after verifying the remote resources.`,
                          project,
                          environment: request.name,
                          cause: `${project}/${request.name}`,
                        });
                      }
                      for (const desired of desiredDatasets) {
                        const matches = verified.filter((dataset) => dataset.name === desired.name);
                        const dataset = matches[0];
                        if (
                          matches.length !== 1 ||
                          dataset === undefined ||
                          dataset.kind !== desired.kind ||
                          (axiomEdgeDeployment !== undefined &&
                            dataset.edgeDeployment !== axiomEdgeDeployment) ||
                          (axiomRetentionDays !== undefined &&
                            (!dataset.useRetentionPeriod ||
                              dataset.retentionDays !== axiomRetentionDays))
                        ) {
                          return yield* new RemoteEnvironmentError({
                            code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                            message: `A fresh Axiom verification found an incompatible dataset ${desired.name}. Reconcile its kind, edge deployment and retention before confirming correlation.`,
                            cause: desired.name,
                          });
                        }
                      }
                      const freshMetrics = verified.find(
                        (dataset) => dataset.name === request.datasets.metrics,
                      );
                      if (freshMetrics?.edgeDeployment === undefined) {
                        return yield* new RemoteEnvironmentError({
                          code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                          message: `Axiom metrics dataset ${request.datasets.metrics} has no verified edge deployment. Configure one before confirming correlation.`,
                          cause: request.datasets.metrics,
                        });
                      }
                    }
                    const traces = verified.find(
                      (dataset) => dataset.name === request.datasets.traces,
                    );
                    const logs = verified.find((dataset) => dataset.name === request.datasets.logs);
                    const metrics = verified.find(
                      (dataset) => dataset.name === request.datasets.metrics,
                    );
                    if (traces === undefined || logs === undefined || metrics === undefined) {
                      return yield* new RemoteEnvironmentError({
                        code: "OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT",
                        message: `Axiom did not return the complete dataset contract for ${project}/${request.name}. Verify the remote resources before retrying.`,
                        cause: `${project}/${request.name}`,
                      });
                    }
                    const groupName = `${project} ${request.name}`;
                    const groupSlug = `${project}-${request.name}`;
                    const currentCorrelation = Option.isSome(axiom)
                      ? axiom.value.correlation
                      : undefined;
                    let correlation: AxiomEnvironment["correlation"] = {
                      type: "manual-required",
                      groupName,
                      groupSlug,
                      tracesDataset: request.datasets.traces,
                      logsDataset: request.datasets.logs,
                      metricsDataset: request.datasets.metrics,
                    };
                    if (correlationConfirmed) {
                      const now = yield* DateTime.now;
                      correlation = {
                        type: "operator-confirmed",
                        groupName,
                        groupSlug,
                        tracesDataset: request.datasets.traces,
                        logsDataset: request.datasets.logs,
                        metricsDataset: request.datasets.metrics,
                        confirmedAt: DateTime.formatIso(now),
                      };
                    } else if (currentCorrelation?.type === "operator-confirmed") {
                      correlation = currentCorrelation;
                    }
                    axiom = Option.some(
                      new AxiomEnvironment({
                        tokenId: token.id,
                        token: token.token,
                        tracesDataset: request.datasets.traces,
                        logsDataset: request.datasets.logs,
                        metricsDataset: request.datasets.metrics,
                        datasets: {
                          traces: verifiedDataset(traces),
                          logs: verifiedDataset(logs),
                          metrics: verifiedDataset(metrics),
                        },
                        correlation,
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
        }),
        list,
        export: Effect.fn("RemoteEnvironment.export")(function* (rawProject, rawEnvironment) {
          const project = yield* parseServiceName(rawProject);
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
          const managedAxiom = environmentAxiom(managed);
          if (
            Option.isSome(managedAxiom) &&
            managedAxiom.value.correlation.type !== "operator-confirmed"
          ) {
            return yield* new RemoteEnvironmentError({
              code: "OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED",
              message: `Correlation for ${project}/${environment} requires a manual Axiom Console action. Create the saved group and rerun provisioning with --correlation-confirmed before exporting deploy variables.`,
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
              ["OTEL_EXPORTER_OTLP_ENDPOINT", `http://${managed.project}-otel-collector:4318`],
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
