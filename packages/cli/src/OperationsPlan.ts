import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { CredentialsStore, type CredentialsError } from "./CredentialsStore.ts";
import {
  type AxiomDataset,
  type AxiomDatasetKind,
  AxiomApi,
  RemoteApiError,
  SentryApi,
} from "./ProviderApis.ts";
import { environmentDatasets } from "./RemoteEnvironment.ts";
import { type ValidatedOperationsManifest } from "./OperationsManifest.ts";
import {
  ManualAction,
  MutationIntent,
  OperationsState,
  OperationsStateDocument,
  type OperationsStateError,
} from "./OperationsState.ts";

export class OperationPlanAction extends Schema.Class<OperationPlanAction>(
  "@equipe-tech/observability-cli/OperationPlanAction",
)({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["create", "manual", "destructive"]),
  provider: Schema.Literals(["Axiom", "Sentry"]),
  capability: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  desiredFingerprint: Schema.NonEmptyString,
  observedFingerprint: Schema.NonEmptyString,
}) {}

export class OperationsPlanDocument extends Schema.Class<OperationsPlanDocument>(
  "@equipe-tech/observability-cli/OperationsPlanDocument",
)({
  version: Schema.Literal(1),
  service: Schema.NonEmptyString,
  environments: Schema.Array(Schema.NonEmptyString),
  manifestFingerprint: Schema.NonEmptyString,
  contractFingerprint: Schema.NonEmptyString,
  observedFingerprint: Schema.NonEmptyString,
  actions: Schema.Array(OperationPlanAction),
  pendingManualActions: Schema.Array(ManualAction),
  digest: Schema.NonEmptyString,
}) {}

export class OperationsError extends Schema.TaggedError<OperationsError>()("OperationsError", {
  code: Schema.Literals([
    "OBS_CLI_PLAN_REQUIRED",
    "OBS_CLI_PLAN_INVALID",
    "OBS_CLI_PLAN_STALE",
    "OBS_CLI_PLAN_DESTRUCTIVE",
    "OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE",
    "OBS_CLI_READ_BACK_TIMEOUT",
    "OBS_CLI_MANUAL_ACTION_PENDING",
    "OBS_CLI_DRIFT_DETECTED",
    "OBS_CLI_APPLY_OUTCOME_UNKNOWN",
  ]),
  message: Schema.String,
  attempts: Schema.Int.pipe(Schema.optionalKey),
  lastResponse: Schema.String.pipe(Schema.optionalKey),
  cause: Schema.Defect(),
}) {}

const decodePlan = Schema.decodeUnknownEffect(OperationsPlanDocument, {
  onExcessProperty: "error",
});

const fingerprint = (value: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
};

const planPayload = (plan: Omit<OperationsPlanDocument, "digest">): string =>
  JSON.stringify({
    version: plan.version,
    service: plan.service,
    environments: plan.environments,
    manifestFingerprint: plan.manifestFingerprint,
    contractFingerprint: plan.contractFingerprint,
    observedFingerprint: plan.observedFingerprint,
    actions: plan.actions,
    pendingManualActions: plan.pendingManualActions,
  });

const desiredDatasetEntries = Effect.fn("desiredDatasetEntries")(function* (
  service: string,
  environments: ReadonlyArray<string>,
) {
  const entries: Array<{
    readonly environment: string;
    readonly name: string;
    readonly kind: AxiomDatasetKind;
  }> = [];
  for (const environment of environments) {
    const names = yield* environmentDatasets(service, environment);
    entries.push(
      { environment, name: names.traces, kind: "axiom:events:v1" },
      { environment, name: names.logs, kind: "axiom:events:v1" },
      { environment, name: names.metrics, kind: "otel:metrics:v1" },
    );
  }
  return entries;
});

const observedDatasetFingerprint = (dataset: AxiomDataset): string =>
  fingerprint(
    JSON.stringify({
      name: dataset.name,
      kind: dataset.kind,
      retentionDays: dataset.retentionDays,
      useRetentionPeriod: dataset.useRetentionPeriod,
    }),
  );

type SentryPrerequisite = {
  readonly environment: string;
  readonly projectExists: boolean;
  readonly dsnExists: boolean;
};

const makePlan = (
  validated: ValidatedOperationsManifest,
  selectedEnvironments: ReadonlyArray<string>,
  datasets: ReadonlyArray<AxiomDataset>,
  sentryPrerequisites: ReadonlyArray<SentryPrerequisite>,
  state: OperationsStateDocument,
): Effect.Effect<OperationsPlanDocument, never, never> =>
  Effect.gen(function* () {
    const manifest = validated.manifest;
    const actions: Array<OperationPlanAction> = [];
    const desiredDatasets = yield* desiredDatasetEntries(
      manifest.service,
      selectedEnvironments,
    ).pipe(Effect.orDie);
    for (const desired of desiredDatasets) {
      const matches = datasets.filter((dataset) => dataset.name === desired.name);
      const observed = matches[0];
      const desiredFingerprint = fingerprint(
        JSON.stringify({ name: desired.name, kind: desired.kind }),
      );
      if (matches.length === 0) {
        actions.push(
          new OperationPlanAction({
            id: `axiom.dataset.${desired.name}`,
            kind: "create",
            provider: "Axiom",
            capability: "dataset",
            resource: desired.name,
            environment: desired.environment,
            desiredFingerprint,
            observedFingerprint: fingerprint("absent"),
          }),
        );
      } else if (matches.length !== 1 || observed === undefined || observed.kind !== desired.kind) {
        actions.push(
          new OperationPlanAction({
            id: `axiom.dataset.${desired.name}`,
            kind: "destructive",
            provider: "Axiom",
            capability: "dataset-kind",
            resource: desired.name,
            environment: desired.environment,
            desiredFingerprint,
            observedFingerprint:
              observed === undefined
                ? fingerprint("duplicate")
                : observedDatasetFingerprint(observed),
          }),
        );
      }
    }
    const desiredDatasetNames = new Set(desiredDatasets.map((entry) => entry.name));
    const manualDefinitions: Array<{
      readonly id: string;
      readonly provider: "Axiom" | "Sentry";
      readonly capability: string;
      readonly environment: string;
      readonly desiredFingerprint: string;
      readonly kind: "manual" | "destructive";
      readonly publiclySatisfied: boolean;
    }> = [];
    for (const environment of selectedEnvironments) {
      const retention = manifest.retention.find((entry) => entry.environment === environment);
      if (retention !== undefined) {
        const environmentNames = desiredDatasets
          .filter((entry) => entry.environment === environment)
          .map((entry) => entry.name);
        const environmentDatasets = environmentNames.flatMap((name) =>
          datasets.filter((dataset) => dataset.name === name),
        );
        manualDefinitions.push({
          id: `axiom.retention.${environment}`,
          provider: "Axiom",
          capability: "retention",
          environment,
          desiredFingerprint: fingerprint(JSON.stringify({ days: retention.days })),
          kind: environmentDatasets.some(
            (dataset) =>
              dataset.useRetentionPeriod &&
              dataset.retentionDays !== undefined &&
              dataset.retentionDays > retention.days,
          )
            ? "destructive"
            : "manual",
          publiclySatisfied:
            environmentDatasets.length === environmentNames.length &&
            environmentDatasets.every(
              (dataset) => dataset.useRetentionPeriod && dataset.retentionDays === retention.days,
            ),
        });
      }
      manualDefinitions.push({
        id: `axiom.correlation.${environment}`,
        provider: "Axiom",
        capability: "correlation",
        environment,
        desiredFingerprint: fingerprint(JSON.stringify({ service: manifest.service, environment })),
        kind: "manual",
        publiclySatisfied: true,
      });
      for (const dashboard of validated.dashboards) {
        manualDefinitions.push({
          id: `axiom.dashboard.${environment}.${dashboard.definition.id}`,
          provider: "Axiom",
          capability: "dashboard",
          environment,
          desiredFingerprint: fingerprint(JSON.stringify(dashboard.definition)),
          kind: "manual",
          publiclySatisfied: true,
        });
      }
      for (const monitor of validated.monitors) {
        manualDefinitions.push({
          id: `axiom.monitor.${environment}.${monitor.definition.id}`,
          provider: "Axiom",
          capability: "monitor",
          environment,
          desiredFingerprint: fingerprint(JSON.stringify(monitor.definition)),
          kind: "manual",
          publiclySatisfied: true,
        });
      }
      if (manifest.sentry.enabled) {
        manualDefinitions.push({
          id: `sentry.project.${environment}`,
          provider: "Sentry",
          capability: "project-and-client-key",
          environment,
          desiredFingerprint: fingerprint(
            JSON.stringify({ project: `${manifest.service}-${environment}` }),
          ),
          kind: "manual",
          publiclySatisfied:
            sentryPrerequisites.find((entry) => entry.environment === environment)
              ?.projectExists === true &&
            sentryPrerequisites.find((entry) => entry.environment === environment)?.dsnExists ===
              true,
        });
      }
    }
    for (const manual of manualDefinitions) {
      const persisted = state.manualActions.find(
        (entry) => entry.id === manual.id && entry.desiredFingerprint === manual.desiredFingerprint,
      );
      if (
        persisted === undefined ||
        (persisted.status === "operator-confirmed" && !manual.publiclySatisfied)
      ) {
        actions.push(
          new OperationPlanAction({
            id: manual.id,
            kind: manual.kind,
            provider: manual.provider,
            capability: manual.capability,
            resource: manual.id,
            environment: manual.environment,
            desiredFingerprint: manual.desiredFingerprint,
            observedFingerprint: fingerprint(
              manual.publiclySatisfied ? "observed" : "prerequisite-drift",
            ),
          }),
        );
      }
    }
    actions.sort((left, right) => left.id.localeCompare(right.id));
    const selectedDatasets = datasets
      .filter((dataset) => desiredDatasetNames.has(dataset.name))
      .map((dataset) => ({ name: dataset.name, fingerprint: observedDatasetFingerprint(dataset) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const observedFingerprint = fingerprint(JSON.stringify(selectedDatasets));
    const pendingManualActions = state.manualActions
      .filter(
        (action) =>
          selectedEnvironments.includes(action.environment) && action.status === "pending",
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const withoutDigest: Omit<OperationsPlanDocument, "digest"> = {
      version: 1,
      service: manifest.service,
      environments: [...selectedEnvironments].sort(),
      manifestFingerprint: fingerprint(JSON.stringify(manifest)),
      contractFingerprint: fingerprint(JSON.stringify(validated.contract)),
      observedFingerprint,
      actions,
      pendingManualActions,
    };
    return new OperationsPlanDocument({
      ...withoutDigest,
      digest: fingerprint(planPayload(withoutDigest)),
    });
  });

const selectEnvironments = (
  validated: ValidatedOperationsManifest,
  requested: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, OperationsError> => {
  const selected = requested.length === 0 ? validated.manifest.environments : requested;
  for (const environment of selected) {
    if (!validated.manifest.environments.includes(environment)) {
      return Effect.fail(
        new OperationsError({
          code: "OBS_CLI_PLAN_INVALID",
          message: `Environment ${environment} is not declared by the operations manifest.`,
          cause: environment,
        }),
      );
    }
  }
  return Effect.succeed([...new Set(selected)].sort());
};

export type PlanRequest = {
  readonly validated: ValidatedOperationsManifest;
  readonly environments: ReadonlyArray<string>;
};

type OperationsServiceError =
  | OperationsError
  | RemoteApiError
  | CredentialsError
  | OperationsStateError;

export class OperationsPlanner extends Context.Service<
  OperationsPlanner,
  {
    plan(request: PlanRequest): Effect.Effect<OperationsPlanDocument, OperationsServiceError>;
    parsePlan(content: string): Effect.Effect<OperationsPlanDocument, OperationsError>;
    apply(
      request: PlanRequest,
      supplied: OperationsPlanDocument,
      allowDestructive: boolean,
      confirmedManualActions: ReadonlyArray<string>,
    ): Effect.Effect<OperationsPlanDocument, OperationsServiceError>;
    verify(request: PlanRequest): Effect.Effect<OperationsPlanDocument, OperationsServiceError>;
  }
>()("@equipe-tech/observability-cli/OperationsPlanner") {
  static readonly layer = Layer.effect(
    OperationsPlanner,
    Effect.gen(function* () {
      const credentialsStore = yield* CredentialsStore;
      const axiom = yield* AxiomApi;
      const sentry = yield* SentryApi;
      const stateStore = yield* OperationsState;

      const observe = Effect.fn("OperationsPlanner.observe")(function* (request: PlanRequest) {
        const environments = yield* selectEnvironments(request.validated, request.environments);
        const credentials = yield* credentialsStore.load();
        if (Option.isNone(credentials) || credentials.value.axiom === undefined) {
          return yield* new OperationsError({
            code: "OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE",
            message:
              "Axiom credentials are required after manifest validation. Run observability auth login axiom.",
            cause: "Axiom",
          });
        }
        const datasets = yield* axiom.datasets(credentials.value.axiom);
        const sentryPrerequisites: Array<SentryPrerequisite> = [];
        if (request.validated.manifest.sentry.enabled) {
          const sentryCredentials = credentials.value.sentry;
          if (sentryCredentials === undefined) {
            return yield* new OperationsError({
              code: "OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE",
              message:
                "Sentry credentials are required after manifest validation. Run observability auth login sentry.",
              cause: "Sentry",
            });
          }
          for (const environment of environments) {
            const project = `${request.validated.manifest.service}-${environment}`;
            const projectExists = yield* sentry.project(sentryCredentials, project);
            const dsnExists = projectExists
              ? yield* sentry.clientKeyExists(sentryCredentials, project)
              : false;
            sentryPrerequisites.push({ environment, projectExists, dsnExists });
          }
        }
        const state = yield* stateStore.load(request.validated.manifest.service);
        return {
          environments,
          datasets,
          sentryPrerequisites,
          state,
          axiomCredentials: credentials.value.axiom,
          credentials: credentials.value,
        };
      });

      const plan = Effect.fn("OperationsPlanner.plan")(function* (request: PlanRequest) {
        const observed = yield* observe(request);
        return yield* makePlan(
          request.validated,
          observed.environments,
          observed.datasets,
          observed.sentryPrerequisites,
          observed.state,
        );
      });

      const parsePlan = Effect.fn("OperationsPlanner.parsePlan")(function* (content: string) {
        if (content.length > 2_097_152) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_INVALID",
            message: "The plan file exceeds 2097152 bytes.",
            cause: content.length,
          });
        }
        const document = yield* Effect.try({
          try: () => JSON.parse(content),
          catch: (cause) =>
            new OperationsError({
              code: "OBS_CLI_PLAN_INVALID",
              message: "The plan file is not valid JSON.",
              cause,
            }),
        });
        const decoded = yield* decodePlan(document).pipe(
          Effect.mapError(
            (cause) =>
              new OperationsError({
                code: "OBS_CLI_PLAN_INVALID",
                message: "The plan file does not match plan version 1.",
                cause,
              }),
          ),
        );
        const expected = fingerprint(
          planPayload({
            version: decoded.version,
            service: decoded.service,
            environments: decoded.environments,
            manifestFingerprint: decoded.manifestFingerprint,
            contractFingerprint: decoded.contractFingerprint,
            observedFingerprint: decoded.observedFingerprint,
            actions: decoded.actions,
            pendingManualActions: decoded.pendingManualActions,
          }),
        );
        if (expected !== decoded.digest) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_INVALID",
            message: "The plan digest does not match its contents.",
            cause: decoded.digest,
          });
        }
        return decoded;
      });

      const apply = Effect.fn("OperationsPlanner.apply")(function* (
        request: PlanRequest,
        supplied: OperationsPlanDocument,
        allowDestructive: boolean,
        confirmedManualActions: ReadonlyArray<string>,
      ) {
        const observed = yield* observe(request);
        const current = yield* makePlan(
          request.validated,
          observed.environments,
          observed.datasets,
          observed.sentryPrerequisites,
          observed.state,
        );
        if (current.digest !== supplied.digest) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_STALE",
            message: `The supplied plan is stale. Run ops plan again. Current digest ${current.digest}.`,
            cause: supplied.digest,
          });
        }
        if (current.actions.some((action) => action.kind === "destructive") && !allowDestructive) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_DESTRUCTIVE",
            message: `Plan ${current.digest} contains destructive changes. Rerun with --allow-destructive and this exact plan.`,
            cause: current.digest,
          });
        }
        const manualActionIds = new Set([
          ...current.actions
            .filter((action) => action.kind !== "create")
            .map((action) => action.id),
          ...current.pendingManualActions.map((action) => action.id),
        ]);
        const invalidConfirmation = confirmedManualActions.find((id) => !manualActionIds.has(id));
        if (invalidConfirmation !== undefined) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_INVALID",
            message: `Manual action ${invalidConfirmation} is not contained in plan ${current.digest}.`,
            cause: invalidConfirmation,
          });
        }
        let stateGeneration = observed.state.generation;
        for (const unresolved of observed.state.mutations.filter(
          (mutation) => mutation.status === "pending" || mutation.status === "outcome-unknown",
        )) {
          const expectedKind: AxiomDatasetKind = unresolved.resource.endsWith("-metrics")
            ? "otel:metrics:v1"
            : "axiom:events:v1";
          const reconciled = observed.datasets.some(
            (dataset) => dataset.name === unresolved.resource && dataset.kind === expectedKind,
          );
          if (reconciled) {
            const next = yield* stateStore.update(
              current.service,
              stateGeneration,
              (state) =>
                new OperationsStateDocument({
                  version: state.version,
                  generation: state.generation,
                  service: state.service,
                  manualActions: state.manualActions,
                  mutations: state.mutations.map((entry) =>
                    entry.id === unresolved.id
                      ? new MutationIntent({
                          id: entry.id,
                          operation: entry.operation,
                          resource: entry.resource,
                          desiredFingerprint: entry.desiredFingerprint,
                          status: "resolved",
                          updatedAt: entry.updatedAt,
                        })
                      : entry,
                  ),
                }),
            );
            stateGeneration = next.generation;
            continue;
          }
          if (unresolved.status === "pending") {
            const next = yield* stateStore.update(
              current.service,
              stateGeneration,
              (state) =>
                new OperationsStateDocument({
                  version: state.version,
                  generation: state.generation,
                  service: state.service,
                  manualActions: state.manualActions,
                  mutations: state.mutations.map((entry) =>
                    entry.id === unresolved.id
                      ? new MutationIntent({
                          id: entry.id,
                          operation: entry.operation,
                          resource: entry.resource,
                          desiredFingerprint: entry.desiredFingerprint,
                          status: "outcome-unknown",
                          updatedAt: entry.updatedAt,
                        })
                      : entry,
                  ),
                }),
            );
            stateGeneration = next.generation;
          }
          return yield* new OperationsError({
            code: "OBS_CLI_APPLY_OUTCOME_UNKNOWN",
            message: `Mutation ${unresolved.id} has an unknown outcome. Reconcile it before applying more work.`,
            cause: unresolved.id,
          });
        }
        for (const confirmation of confirmedManualActions) {
          const pending = current.pendingManualActions.find((action) => action.id === confirmation);
          if (pending === undefined) continue;
          const next = yield* stateStore.update(
            current.service,
            stateGeneration,
            (state) =>
              new OperationsStateDocument({
                version: state.version,
                generation: state.generation,
                service: state.service,
                mutations: state.mutations,
                manualActions: state.manualActions.map((action) =>
                  action.id === confirmation
                    ? new ManualAction({
                        id: action.id,
                        provider: action.provider,
                        capability: action.capability,
                        environment: action.environment,
                        desiredFingerprint: action.desiredFingerprint,
                        status: "operator-confirmed",
                      })
                    : action,
                ),
              }),
          );
          stateGeneration = next.generation;
        }
        for (const action of current.actions) {
          if (action.kind === "manual" || action.kind === "destructive") {
            const legacyEnvironment = observed.credentials.environments.find(
              (environment) =>
                environment.project === current.service &&
                environment.environment === action.environment,
            );
            const legacyCorrelation =
              legacyEnvironment === undefined || legacyEnvironment.providers.type === "sentry"
                ? undefined
                : legacyEnvironment.providers.axiom.correlation;
            const migratedConfirmation =
              action.capability === "correlation" &&
              legacyCorrelation?.type === "operator-confirmed";
            const operatorConfirmed =
              migratedConfirmation || confirmedManualActions.includes(action.id);
            const manualAction = operatorConfirmed
              ? new ManualAction({
                  id: action.id,
                  provider: action.provider,
                  capability: action.capability,
                  environment: action.environment,
                  desiredFingerprint: action.desiredFingerprint,
                  status: "operator-confirmed",
                })
              : new ManualAction({
                  id: action.id,
                  provider: action.provider,
                  capability: action.capability,
                  environment: action.environment,
                  desiredFingerprint: action.desiredFingerprint,
                  status: "pending",
                  expiresAt: new Date(
                    (yield* Clock.currentTimeMillis) + 30 * 24 * 60 * 60 * 1_000,
                  ).toISOString(),
                });
            const next = yield* stateStore.update(
              current.service,
              stateGeneration,
              (state) =>
                new OperationsStateDocument({
                  version: state.version,
                  generation: state.generation,
                  service: state.service,
                  mutations: state.mutations,
                  manualActions: [
                    ...state.manualActions.filter((manual) => manual.id !== action.id),
                    manualAction,
                  ].sort((left, right) => left.id.localeCompare(right.id)),
                }),
            );
            stateGeneration = next.generation;
            continue;
          }
          const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          const pendingState = yield* stateStore.update(
            current.service,
            stateGeneration,
            (state) =>
              new OperationsStateDocument({
                version: state.version,
                generation: state.generation,
                service: state.service,
                manualActions: state.manualActions,
                mutations: [
                  ...state.mutations.filter((mutation) => mutation.id !== action.id),
                  new MutationIntent({
                    id: action.id,
                    operation: action.kind,
                    resource: action.resource,
                    desiredFingerprint: action.desiredFingerprint,
                    status: "pending",
                    updatedAt,
                  }),
                ],
              }),
          );
          stateGeneration = pendingState.generation;
          const persistInterruptedOutcome = () =>
            stateStore
              .update(
                current.service,
                stateGeneration,
                (state) =>
                  new OperationsStateDocument({
                    version: state.version,
                    generation: state.generation,
                    service: state.service,
                    manualActions: state.manualActions,
                    mutations: state.mutations.map((entry) =>
                      entry.id === action.id
                        ? new MutationIntent({
                            id: entry.id,
                            operation: entry.operation,
                            resource: entry.resource,
                            desiredFingerprint: entry.desiredFingerprint,
                            status: "outcome-unknown",
                            updatedAt,
                          })
                        : entry,
                    ),
                  }),
              )
              .pipe(Effect.asVoid);
          const kind: AxiomDatasetKind = action.resource.endsWith("-metrics")
            ? "otel:metrics:v1"
            : "axiom:events:v1";
          const mutation = axiom.createDataset(observed.axiomCredentials, action.resource, {
            kind,
          });
          const handleMutationError = (
            error: RemoteApiError,
          ): Effect.Effect<never, OperationsServiceError> => {
            if (error.code !== "OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN") {
              return Effect.fail(error);
            }
            return Effect.gen(function* () {
              const unknownState = yield* stateStore.update(
                current.service,
                stateGeneration,
                (state) =>
                  new OperationsStateDocument({
                    version: state.version,
                    generation: state.generation,
                    service: state.service,
                    manualActions: state.manualActions,
                    mutations: state.mutations.map((entry) =>
                      entry.id === action.id
                        ? new MutationIntent({
                            id: entry.id,
                            operation: entry.operation,
                            resource: entry.resource,
                            desiredFingerprint: entry.desiredFingerprint,
                            status: "outcome-unknown",
                            updatedAt,
                          })
                        : entry,
                    ),
                  }),
              );
              stateGeneration = unknownState.generation;
              return yield* new OperationsError({
                code: "OBS_CLI_APPLY_OUTCOME_UNKNOWN",
                message: `The outcome of mutation ${action.id} is unknown. Reconcile it before retrying.`,
                cause: error,
              });
            });
          };
          const created = yield* mutation.pipe(
            Effect.onInterrupt(persistInterruptedOutcome),
            Effect.catchTag("RemoteApiError", handleMutationError),
          );
          let matched = false;
          let attempts = 0;
          let lastResponse = `status=200 name=${created.name} kind=${created.kind}`.slice(0, 512);
          while (!matched && attempts < 6) {
            attempts += 1;
            const datasets = yield* axiom
              .datasets(observed.axiomCredentials)
              .pipe(Effect.onInterrupt(persistInterruptedOutcome));
            const readBack = datasets.find(
              (dataset) => dataset.name === action.resource && dataset.kind === kind,
            );
            matched = readBack !== undefined;
            lastResponse = `status=200 matched=${matched} resource=${action.resource}`.slice(
              0,
              512,
            );
            if (!matched && attempts < 6) {
              yield* Effect.sleep(`${Math.min(250 * 2 ** attempts, 4_000)} millis`).pipe(
                Effect.onInterrupt(persistInterruptedOutcome),
              );
            }
          }
          if (!matched) {
            const unknownState = yield* stateStore.update(
              current.service,
              stateGeneration,
              (state) =>
                new OperationsStateDocument({
                  version: state.version,
                  generation: state.generation,
                  service: state.service,
                  manualActions: state.manualActions,
                  mutations: state.mutations.map((entry) =>
                    entry.id === action.id
                      ? new MutationIntent({
                          id: entry.id,
                          operation: entry.operation,
                          resource: entry.resource,
                          desiredFingerprint: entry.desiredFingerprint,
                          status: "outcome-unknown",
                          updatedAt,
                        })
                      : entry,
                  ),
                }),
            );
            stateGeneration = unknownState.generation;
            return yield* new OperationsError({
              code: "OBS_CLI_READ_BACK_TIMEOUT",
              message: `Read-back for ${action.resource} did not converge after ${attempts} attempts.`,
              attempts,
              lastResponse,
              cause: action.id,
            });
          }
          const resolvedState = yield* stateStore.update(
            current.service,
            stateGeneration,
            (state) =>
              new OperationsStateDocument({
                version: state.version,
                generation: state.generation,
                service: state.service,
                manualActions: state.manualActions,
                mutations: state.mutations.map((mutation) =>
                  mutation.id === action.id
                    ? new MutationIntent({
                        id: mutation.id,
                        operation: mutation.operation,
                        resource: mutation.resource,
                        desiredFingerprint: mutation.desiredFingerprint,
                        status: "resolved",
                        updatedAt,
                      })
                    : mutation,
                ),
              }),
          );
          stateGeneration = resolvedState.generation;
        }
        return yield* plan(request);
      });

      const verify = Effect.fn("OperationsPlanner.verify")(function* (request: PlanRequest) {
        const current = yield* plan(request);
        if (current.actions.length > 0) {
          return yield* new OperationsError({
            code: "OBS_CLI_DRIFT_DETECTED",
            message: `Operations drift detected. Plan ${current.digest} has ${current.actions.length} pending changes.`,
            cause: current.digest,
          });
        }
        const pending = current.pendingManualActions[0];
        if (pending !== undefined) {
          const now = yield* Clock.currentTimeMillis;
          const expired = pending.expiresAt !== undefined && Date.parse(pending.expiresAt) <= now;
          return yield* new OperationsError({
            code: "OBS_CLI_MANUAL_ACTION_PENDING",
            message: expired
              ? `Manual action ${pending.id} expired before operator confirmation.`
              : `Manual action ${pending.id} is pending operator confirmation.`,
            cause: pending.id,
          });
        }
        return current;
      });

      return OperationsPlanner.of({ plan, parsePlan, apply, verify });
    }),
  );
}

export const encodeOperationsPlan = (plan: OperationsPlanDocument): string =>
  `${JSON.stringify(plan, null, 2)}\n`;
