import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { classifyAxiomRetentionChange } from "./AxiomDatasetRetention.ts";
import { CredentialsStore, type CredentialsError } from "./CredentialsStore.ts";
import {
  type AxiomDataset,
  type AxiomDatasetKind,
  AxiomApi,
  RemoteApiError,
  SentryApi,
} from "./ProviderApis.ts";
import { environmentAxiom, environmentDatasets, RemoteEnvironment } from "./RemoteEnvironment.ts";
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
  credentialsFingerprint: Schema.NonEmptyString,
  queueMode: Schema.Literals(["best-effort", "durable"]),
  bestEffortDataLossAccepted: Schema.Boolean,
  axiomEdgeDeployment: Schema.NonEmptyString,
  localAssetsFingerprint: Schema.NonEmptyString,
  localAssetPaths: Schema.Array(Schema.NonEmptyString),
  localAssetChanges: Schema.Array(Schema.NonEmptyString),
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
    "OBS_CLI_MUTATION_UNRESOLVED",
  ]),
  message: Schema.String,
  attempts: Schema.Int.pipe(Schema.optionalKey),
  lastResponse: Schema.String.pipe(Schema.optionalKey),
  cause: Schema.Defect(),
}) {}

const decodePlan = Schema.decodeUnknownEffect(OperationsPlanDocument, {
  onExcessProperty: "error",
});
const OperationsPlanEnvironment = Schema.Struct({
  NODE_ENV: Schema.NonEmptyString.pipe(Schema.optionalKey),
});
const operationsPlanEnvironment = Schema.decodeUnknownSync(OperationsPlanEnvironment)(process.env);

const isDestructiveManualAction = (action: ManualAction): boolean =>
  action.kind === "destructive" || (action.kind === undefined && action.capability === "retention");

const mutationWithStatus = (
  mutation: MutationIntent,
  status: MutationIntent["status"],
  updatedAt: string,
): MutationIntent =>
  new MutationIntent({
    id: mutation.id,
    operation: mutation.operation,
    resource: mutation.resource,
    environment: mutation.environment,
    desiredFingerprint: mutation.desiredFingerprint,
    status,
    updatedAt,
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
    credentialsFingerprint: plan.credentialsFingerprint,
    queueMode: plan.queueMode,
    bestEffortDataLossAccepted: plan.bestEffortDataLossAccepted,
    axiomEdgeDeployment: plan.axiomEdgeDeployment,
    localAssetsFingerprint: plan.localAssetsFingerprint,
    localAssetPaths: plan.localAssetPaths,
    localAssetChanges: plan.localAssetChanges,
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

const manualDefinitionIds = (
  validated: ValidatedOperationsManifest,
  selectedEnvironments: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const environment of selectedEnvironments) {
    if (validated.manifest.retention.some((entry) => entry.environment === environment)) {
      ids.add(`axiom.retention.${environment}`);
    }
    ids.add(`axiom.correlation.${environment}`);
    for (const dashboard of validated.dashboards) {
      ids.add(`axiom.dashboard.${environment}.${dashboard.definition.id}`);
    }
    for (const monitor of validated.monitors) {
      ids.add(`axiom.monitor.${environment}.${monitor.definition.id}`);
    }
  }
  return ids;
};

const makePlan = (
  validated: ValidatedOperationsManifest,
  selectedEnvironments: ReadonlyArray<string>,
  datasets: ReadonlyArray<AxiomDataset>,
  sentryPrerequisites: ReadonlyArray<SentryPrerequisite>,
  tokens: ReadonlyArray<import("./ProviderApis.ts").AxiomToken>,
  managedEnvironments: ReadonlyArray<import("./CredentialsStore.ts").ManagedEnvironment>,
  credentialsFingerprint: string,
  queueMode: "best-effort" | "durable",
  bestEffortDataLossAccepted: boolean,
  axiomEdgeDeployment: string,
  localAssetsFingerprint: string,
  localAssetPaths: ReadonlyArray<string>,
  localAssetChanges: ReadonlyArray<string>,
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
        JSON.stringify({
          name: desired.name,
          kind: desired.kind,
          edgeDeployment: axiomEdgeDeployment,
        }),
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
      } else if (
        matches.length !== 1 ||
        observed === undefined ||
        observed.kind !== desired.kind ||
        observed.edgeDeployment !== axiomEdgeDeployment
      ) {
        actions.push(
          new OperationPlanAction({
            id: `axiom.dataset.${desired.name}`,
            kind: "destructive",
            provider: "Axiom",
            capability:
              observed?.kind !== desired.kind ? "dataset-kind" : "dataset-edge-deployment",
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
    for (const environment of selectedEnvironments) {
      const datasets = yield* environmentDatasets(manifest.service, environment).pipe(Effect.orDie);
      const names = [datasets.traces, datasets.logs, datasets.metrics];
      const tokenName = `${manifest.service}-${environment}-collector`;
      const matching = tokens.filter((token) => token.name === tokenName);
      const managed = managedEnvironments.find(
        (candidate) =>
          candidate.project === manifest.service && candidate.environment === environment,
      );
      const localTokenId =
        managed === undefined
          ? undefined
          : Option.getOrUndefined(environmentAxiom(managed))?.tokenId;
      const desiredFingerprint = fingerprint(JSON.stringify({ name: tokenName, datasets: names }));
      if (matching.length === 0) {
        actions.push(
          new OperationPlanAction({
            id: `axiom.token.${environment}`,
            kind: "create",
            provider: "Axiom",
            capability: "ingestion-token",
            resource: tokenName,
            environment,
            desiredFingerprint,
            observedFingerprint: fingerprint("absent"),
          }),
        );
      } else if (matching.length !== 1 || matching[0]?.id !== localTokenId) {
        actions.push(
          new OperationPlanAction({
            id: `axiom.token.${environment}`,
            kind: "destructive",
            provider: "Axiom",
            capability: "ingestion-token",
            resource: tokenName,
            environment,
            desiredFingerprint,
            observedFingerprint: fingerprint(JSON.stringify(matching.map((token) => token.id))),
          }),
        );
      }
    }
    if (
      manifest.sentry.enabled &&
      sentryPrerequisites.every((entry) => !entry.projectExists || !entry.dsnExists)
    ) {
      const environment = selectedEnvironments[0];
      if (environment !== undefined) {
        actions.push(
          new OperationPlanAction({
            id: `sentry.project.${manifest.service}`,
            kind: "create",
            provider: "Sentry",
            capability: "project-and-client-key",
            resource: manifest.service,
            environment,
            desiredFingerprint: fingerprint(JSON.stringify({ project: manifest.service })),
            observedFingerprint: fingerprint("absent-or-missing-client-key"),
          }),
        );
        actions.sort((left, right) => left.id.localeCompare(right.id));
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
        const matchingDatasets = environmentNames.flatMap((name) =>
          datasets.filter((dataset) => dataset.name === name),
        );
        manualDefinitions.push({
          id: `axiom.retention.${environment}`,
          provider: "Axiom",
          capability: "retention",
          environment,
          desiredFingerprint: fingerprint(JSON.stringify({ days: retention.days })),
          kind: classifyAxiomRetentionChange(matchingDatasets, retention.days),
          publiclySatisfied:
            environmentNames.every(
              (name) => matchingDatasets.filter((dataset) => dataset.name === name).length === 1,
            ) &&
            matchingDatasets.every(
              (dataset) => dataset.useRetentionPeriod && dataset.retentionDays === retention.days,
            ),
        });
      }
      manualDefinitions.push({
        id: `axiom.correlation.${environment}`,
        provider: "Axiom",
        capability: "correlation",
        environment,
        desiredFingerprint: fingerprint(
          JSON.stringify({
            service: manifest.service,
            environment,
            edgeDeployment: axiomEdgeDeployment,
          }),
        ),
        kind: "manual",
        publiclySatisfied: desiredDatasets
          .filter((dataset) => dataset.environment === environment)
          .every((desired) =>
            datasets.some(
              (dataset) =>
                dataset.name === desired.name &&
                dataset.kind === desired.kind &&
                dataset.edgeDeployment === axiomEdgeDeployment,
            ),
          ),
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
      .map((dataset) => ({
        name: dataset.name,
        fingerprint: observedDatasetFingerprint(dataset),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const observedFingerprint = fingerprint(JSON.stringify(selectedDatasets));
    const pendingManualActions = manualDefinitions
      .flatMap((manual) => {
        const persisted = state.manualActions.find(
          (action) =>
            action.id === manual.id &&
            action.desiredFingerprint === manual.desiredFingerprint &&
            action.status === "pending",
        );
        if (persisted === undefined) return [];
        const pending =
          persisted.expiresAt === undefined
            ? new ManualAction({
                id: manual.id,
                provider: manual.provider,
                capability: manual.capability,
                environment: manual.environment,
                desiredFingerprint: manual.desiredFingerprint,
                kind: manual.kind,
                status: "pending",
              })
            : new ManualAction({
                id: manual.id,
                provider: manual.provider,
                capability: manual.capability,
                environment: manual.environment,
                desiredFingerprint: manual.desiredFingerprint,
                kind: manual.kind,
                status: "pending",
                expiresAt: persisted.expiresAt,
              });
        return [pending];
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const withoutDigest: Omit<OperationsPlanDocument, "digest"> = {
      version: 1,
      service: manifest.service,
      environments: [...selectedEnvironments].sort(),
      manifestFingerprint: fingerprint(JSON.stringify(manifest)),
      contractFingerprint: fingerprint(JSON.stringify(validated.contract)),
      observedFingerprint,
      credentialsFingerprint,
      queueMode,
      bestEffortDataLossAccepted,
      axiomEdgeDeployment,
      localAssetsFingerprint,
      localAssetPaths,
      localAssetChanges,
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
  readonly queueMode?: "best-effort" | "durable";
  readonly bestEffortDataLossAccepted?: boolean;
  readonly axiomEdgeDeployment?: string;
  readonly localAssetsFingerprint?: string;
  readonly localAssetPaths?: ReadonlyArray<string>;
  readonly localAssetChanges?: ReadonlyArray<string>;
};

type OperationsServiceError =
  | OperationsError
  | RemoteApiError
  | CredentialsError
  | import("./RemoteEnvironment.ts").RemoteEnvironmentError
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
      const remote = yield* RemoteEnvironment;

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
        const tokens = yield* axiom.tokens(credentials.value.axiom);
        const credentialsFingerprint = fingerprint(
          JSON.stringify({
            axiom: credentials.value.axiom,
            sentry: credentials.value.sentry,
            environments: credentials.value.environments,
            pendingAxiomMutations: credentials.value.pendingAxiomMutations ?? [],
          }),
        );
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
            const project = request.validated.manifest.service;
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
          tokens,
          managedEnvironments: credentials.value.environments,
          credentialsFingerprint,
          state,
          axiomCredentials: credentials.value.axiom,
          credentials: credentials.value,
        };
      });

      const plan = Effect.fn("OperationsPlanner.plan")(function* (request: PlanRequest) {
        const observed = yield* observe(request);
        if (request.axiomEdgeDeployment === undefined) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_INVALID",
            message: "Operations plan requires an explicit --axiom-edge-deployment.",
            cause: "missing-axiom-edge-deployment",
          });
        }
        return yield* makePlan(
          request.validated,
          observed.environments,
          observed.datasets,
          observed.sentryPrerequisites,
          observed.tokens,
          observed.managedEnvironments,
          observed.credentialsFingerprint,
          request.queueMode ?? "durable",
          request.bestEffortDataLossAccepted ?? false,
          request.axiomEdgeDeployment,
          request.localAssetsFingerprint ?? "unbound-local-assets",
          request.localAssetPaths ?? [],
          request.localAssetChanges ?? [],
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
            credentialsFingerprint: decoded.credentialsFingerprint,
            queueMode: decoded.queueMode,
            bestEffortDataLossAccepted: decoded.bestEffortDataLossAccepted,
            axiomEdgeDeployment: decoded.axiomEdgeDeployment,
            localAssetsFingerprint: decoded.localAssetsFingerprint,
            localAssetPaths: decoded.localAssetPaths,
            localAssetChanges: decoded.localAssetChanges,
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
          observed.tokens,
          observed.managedEnvironments,
          observed.credentialsFingerprint,
          request.queueMode ?? "durable",
          request.bestEffortDataLossAccepted ?? false,
          request.axiomEdgeDeployment ?? "missing-edge-deployment",
          request.localAssetsFingerprint ?? "unbound-local-assets",
          request.localAssetPaths ?? [],
          request.localAssetChanges ?? [],
          observed.state,
        );
        if (request.axiomEdgeDeployment === undefined) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_INVALID",
            message:
              "Operations apply requires the exact --axiom-edge-deployment bound to the plan.",
            cause: "missing-axiom-edge-deployment",
          });
        }
        if (current.queueMode === "best-effort" && !current.bestEffortDataLossAccepted) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_INVALID",
            message:
              "Best-effort queue mode can lose telemetry during interruption. Replan and apply with explicit data-loss acceptance.",
            cause: current.queueMode,
          });
        }
        if (current.digest !== supplied.digest) {
          return yield* new OperationsError({
            code: "OBS_CLI_PLAN_STALE",
            message: `The supplied plan is stale. Run ops plan again. Current digest ${current.digest}.`,
            cause: supplied.digest,
          });
        }
        const confirmsDestructiveManualAction = current.pendingManualActions.some(
          (action) =>
            confirmedManualActions.includes(action.id) && isDestructiveManualAction(action),
        );
        if (
          (current.actions.some((action) => action.kind === "destructive") ||
            confirmsDestructiveManualAction) &&
          !allowDestructive
        ) {
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
        for (const environment of current.environments) {
          if (!confirmedManualActions.includes(`axiom.correlation.${environment}`)) continue;
          yield* remote.provision(
            current.service,
            [environment],
            ["axiom"],
            "node",
            false,
            current.axiomEdgeDeployment,
            undefined,
            true,
          );
        }
        let stateGeneration = observed.state.generation;
        const activeManualIds = manualDefinitionIds(
          request.validated,
          request.validated.manifest.environments,
        );
        if (observed.state.manualActions.some((action) => !activeManualIds.has(action.id))) {
          const cleaned = yield* stateStore.update(
            current.service,
            stateGeneration,
            (state) =>
              new OperationsStateDocument({
                version: state.version,
                generation: state.generation,
                service: state.service,
                manualActions: state.manualActions.filter((action) =>
                  activeManualIds.has(action.id),
                ),
                mutations: state.mutations,
              }),
          );
          stateGeneration = cleaned.generation;
        }
        for (const unresolved of observed.state.mutations.filter(
          (mutation) =>
            current.environments.includes(mutation.environment) &&
            (mutation.status === "pending" || mutation.status === "outcome-unknown"),
        )) {
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
                    ? mutationWithStatus(entry, "resolved", entry.updatedAt)
                    : entry,
                ),
              }),
          );
          stateGeneration = next.generation;
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
                        id: pending.id,
                        provider: pending.provider,
                        capability: pending.capability,
                        environment: pending.environment,
                        desiredFingerprint: pending.desiredFingerprint,
                        kind: isDestructiveManualAction(pending) ? "destructive" : "manual",
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
                  kind: action.kind,
                  status: "operator-confirmed",
                })
              : new ManualAction({
                  id: action.id,
                  provider: action.provider,
                  capability: action.capability,
                  environment: action.environment,
                  desiredFingerprint: action.desiredFingerprint,
                  kind: action.kind,
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
          if (action.capability === "ingestion-token") continue;
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
                    environment: action.environment,
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
                        ? mutationWithStatus(entry, "outcome-unknown", updatedAt)
                        : entry,
                    ),
                  }),
              )
              .pipe(Effect.asVoid);
          if (action.provider === "Sentry") {
            const sentryCredentials = observed.credentials.sentry;
            if (sentryCredentials === undefined) {
              return yield* new OperationsError({
                code: "OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE",
                message: "Sentry credentials are required to apply the planned project creation.",
                cause: "Sentry",
              });
            }
            const settleSentryFailure = (
              error: RemoteApiError,
            ): Effect.Effect<never, OperationsError | RemoteApiError | OperationsStateError> =>
              Effect.gen(function* () {
                const outcomeUnknown = error.status === undefined || error.status >= 500;
                const settled = yield* stateStore.update(
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
                          ? mutationWithStatus(
                              entry,
                              outcomeUnknown ? "outcome-unknown" : "resolved",
                              updatedAt,
                            )
                          : entry,
                      ),
                    }),
                );
                stateGeneration = settled.generation;
                if (outcomeUnknown) {
                  return yield* new OperationsError({
                    code: "OBS_CLI_APPLY_OUTCOME_UNKNOWN",
                    message: `The outcome of Sentry mutation ${action.id} is unknown. Reconcile it before retrying.`,
                    cause: error,
                  });
                }
                return yield* error;
              });
            const project = yield* sentry
              .ensureProject(sentryCredentials, current.service, "node")
              .pipe(Effect.catchTag("RemoteApiError", settleSentryFailure));
            yield* sentry
              .dsn(sentryCredentials, project)
              .pipe(Effect.catchTag("RemoteApiError", settleSentryFailure));
            const settled = yield* stateStore.update(
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
                      ? mutationWithStatus(entry, "resolved", updatedAt)
                      : entry,
                  ),
                }),
            );
            stateGeneration = settled.generation;
            continue;
          }
          const kind: AxiomDatasetKind = action.resource.endsWith("-metrics")
            ? "otel:metrics:v1"
            : "axiom:events:v1";
          const mutation = axiom.createDataset(observed.axiomCredentials, action.resource, {
            kind,
            edgeDeployment: current.axiomEdgeDeployment,
          });
          const handleMutationError = (
            error: RemoteApiError,
          ): Effect.Effect<never, OperationsServiceError> => {
            if (error.code !== "OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN") {
              return Effect.gen(function* () {
                const settled = yield* stateStore.update(
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
                          ? mutationWithStatus(entry, "resolved", updatedAt)
                          : entry,
                      ),
                    }),
                );
                stateGeneration = settled.generation;
                return yield* error;
              });
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
                        ? mutationWithStatus(entry, "outcome-unknown", updatedAt)
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
            const datasets = yield* axiom.datasets(observed.axiomCredentials).pipe(
              Effect.onInterrupt(persistInterruptedOutcome),
              Effect.catchTag("RemoteApiError", (error) =>
                handleMutationError(
                  new RemoteApiError({
                    code: "OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN",
                    message: `The outcome of creating Axiom dataset ${action.resource} is unknown because read-back failed.`,
                    provider: "Axiom",
                    status: error.status,
                    cause: error,
                  }),
                ),
              ),
            );
            const readBack = datasets.find(
              (dataset) => dataset.name === action.resource && dataset.kind === kind,
            );
            matched = readBack !== undefined;
            lastResponse = `status=200 matched=${matched} resource=${action.resource}`.slice(
              0,
              512,
            );
            if (!matched && attempts < 6) {
              const delay =
                operationsPlanEnvironment.NODE_ENV === "test"
                  ? 0
                  : Math.min(250 * 2 ** attempts, 4_000);
              if (delay > 0) {
                yield* Effect.sleep(`${delay} millis`).pipe(
                  Effect.onInterrupt(persistInterruptedOutcome),
                );
              }
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
                      ? mutationWithStatus(entry, "outcome-unknown", updatedAt)
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
                    ? mutationWithStatus(mutation, "resolved", updatedAt)
                    : mutation,
                ),
              }),
          );
          stateGeneration = resolvedState.generation;
        }
        const tokenActions = current.actions.filter(
          (action) => action.capability === "ingestion-token",
        );
        const sentryProvisioned = current.actions.some((action) => action.provider === "Sentry");
        for (const environment of current.environments) {
          const tokenAction = tokenActions.find((action) => action.environment === environment);
          if (tokenAction === undefined && !sentryProvisioned) continue;
          yield* remote.provision(
            current.service,
            [environment],
            request.validated.manifest.sentry.enabled ? ["axiom", "sentry"] : ["axiom"],
            "node",
            tokenAction?.kind === "destructive",
            current.axiomEdgeDeployment,
            undefined,
            false,
          );
        }
        return yield* plan(request);
      });

      const verify = Effect.fn("OperationsPlanner.verify")(function* (request: PlanRequest) {
        const current = yield* plan(request);
        const state = yield* stateStore.load(current.service);
        const unresolved = state.mutations.find(
          (mutation) =>
            current.environments.includes(mutation.environment) &&
            (mutation.status === "pending" || mutation.status === "outcome-unknown"),
        );
        if (unresolved !== undefined) {
          return yield* new OperationsError({
            code: "OBS_CLI_MUTATION_UNRESOLVED",
            message: `Mutation ${unresolved.id} is ${unresolved.status}. Reconcile it before verification.`,
            cause: unresolved.id,
          });
        }
        if (current.localAssetChanges.length > 0) {
          return yield* new OperationsError({
            code: "OBS_CLI_DRIFT_DETECTED",
            message: `Local Collector asset drift detected in ${current.localAssetChanges.join(", ")}. Apply an exact operations plan before verification.`,
            cause: current.digest,
          });
        }
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
