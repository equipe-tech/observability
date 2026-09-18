import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CredentialsStore, emptyCredentials } from "./CredentialsStore.ts";
import { ServiceVersion } from "./ResourceNamePolicy.ts";
import { environmentAxiom, environmentSentry, RemoteEnvironment } from "./RemoteEnvironment.ts";

const Repository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  Schema.isMaxLength(200),
);
const DeploymentEnvironment = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/),
  Schema.isMaxLength(255),
);
const Rollout = Schema.Literals(["disabled", "enabled"]);
const Release = ServiceVersion;
const GitHubEnvironmentResponse = Schema.Struct({
  id: Schema.Number,
  name: Schema.NonEmptyString,
  protection_rules: Schema.Array(
    Schema.Struct({
      type: Schema.NonEmptyString,
      prevent_self_review: Schema.Boolean.pipe(Schema.optionalKey),
      reviewers: Schema.Array(
        Schema.Struct({
          reviewer: Schema.Struct({ id: Schema.Number, type: Schema.NonEmptyString }),
        }),
      ).pipe(Schema.optionalKey),
    }),
  ),
  deployment_branch_policy: Schema.Struct({
    protected_branches: Schema.Boolean,
    custom_branch_policies: Schema.Boolean,
  }).pipe(Schema.optionalKey),
});
const GitHubVariablesResponse = Schema.Struct({
  variables: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      value: Schema.String,
      updated_at: Schema.NonEmptyString,
    }),
  ),
});
const GitHubSecretsResponse = Schema.Struct({
  secrets: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      updated_at: Schema.NonEmptyString,
    }),
  ),
});
const decodeRepository = Schema.decodeUnknownEffect(Repository);
const decodeDeploymentEnvironment = Schema.decodeUnknownEffect(DeploymentEnvironment);
const decodeRollout = Schema.decodeUnknownEffect(Rollout);
const decodeRelease = Schema.decodeUnknownEffect(Release);
const decodeEnvironmentResponse = Schema.decodeUnknownEffect(GitHubEnvironmentResponse);
const GitHubVariablesPages = Schema.Union([
  GitHubVariablesResponse,
  Schema.Array(GitHubVariablesResponse),
]);
const GitHubSecretsPages = Schema.Union([
  GitHubSecretsResponse,
  Schema.Array(GitHubSecretsResponse),
]);
const decodeVariablesResponse = Schema.decodeUnknownEffect(GitHubVariablesPages);
const decodeSecretsResponse = Schema.decodeUnknownEffect(GitHubSecretsPages);

const secretNames = new Set(["AXIOM_TOKEN", "SENTRY_DSN"]);
const variableNames = new Set([
  "OTEL_SERVICE_NAME",
  "OTEL_SERVICE_VERSION",
  "OTEL_DEPLOYMENT_ENVIRONMENT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "AXIOM_DATASET_TRACES",
  "AXIOM_DATASET_LOGS",
  "AXIOM_DATASET_METRICS",
  "AXIOM_EDGE_DEPLOYMENT",
  "OBSERVABILITY_TELEMETRY_ROLLOUT",
]);

export class GitHubEnvironmentError extends Schema.TaggedError<GitHubEnvironmentError>()(
  "GitHubEnvironmentError",
  {
    code: Schema.Literals([
      "OBS_CLI_GITHUB_INPUT_INVALID",
      "OBS_CLI_GITHUB_ENVIRONMENT_NOT_FOUND",
      "OBS_CLI_GITHUB_RESPONSE_INVALID",
      "OBS_CLI_GITHUB_COMMAND_FAILED",
      "OBS_CLI_GITHUB_PLAN_INVALID",
      "OBS_CLI_GITHUB_PLAN_STALE",
      "OBS_CLI_GITHUB_ROLLOUT_APPROVAL_REQUIRED",
      "OBS_CLI_GITHUB_APPLY_OUTCOME_UNKNOWN",
      "OBS_CLI_GITHUB_READBACK_FAILED",
      "OBS_CLI_GITHUB_STATE_FAILED",
    ]),
    message: Schema.String,
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {}

export class GitHubPlanAction extends Schema.Class<GitHubPlanAction>(
  "@equipe-tech/observability-cli/GitHubPlanAction",
)({
  kind: Schema.Literals(["set-variable", "overwrite-secret"]),
  mode: Schema.Literals(["create", "update", "overwrite"]),
  name: Schema.NonEmptyString,
  value: Schema.String.pipe(Schema.optionalKey),
  effect: Schema.NonEmptyString,
}) {}

export class GitHubEnvironmentPlan extends Schema.Class<GitHubEnvironmentPlan>(
  "@equipe-tech/observability-cli/GitHubEnvironmentPlan",
)({
  version: Schema.Literal(1),
  repository: Repository,
  project: Schema.NonEmptyString,
  environment: DeploymentEnvironment,
  release: Release,
  rollout: Rollout,
  releaseVariable: Schema.NonEmptyString,
  sentryDsnVariable: Schema.NonEmptyString,
  observedFingerprint: Schema.NonEmptyString,
  configurationFingerprint: Schema.NonEmptyString,
  protectionRules: Schema.Array(Schema.NonEmptyString),
  requiredReviewerIds: Schema.Array(Schema.Number),
  preventSelfReview: Schema.Boolean,
  protectedBranches: Schema.Boolean,
  customBranchPolicies: Schema.Boolean,
  actions: Schema.Array(GitHubPlanAction),
  sideEffects: Schema.Array(Schema.NonEmptyString),
  digest: Schema.NonEmptyString,
}) {}

class GitHubMutationState extends Schema.Class<GitHubMutationState>(
  "@equipe-tech/observability-cli/GitHubMutationState",
)({
  name: Schema.NonEmptyString,
  status: Schema.Literals(["pending", "completed", "outcome-unknown"]),
}) {}

class GitHubApplyState extends Schema.Class<GitHubApplyState>(
  "@equipe-tech/observability-cli/GitHubApplyState",
)({
  version: Schema.Literal(1),
  planDigest: Schema.NonEmptyString,
  repository: Repository,
  environment: DeploymentEnvironment,
  mutations: Schema.Array(GitHubMutationState),
}) {}

export class GitHubApplyReceipt extends Schema.Class<GitHubApplyReceipt>(
  "@equipe-tech/observability-cli/GitHubApplyReceipt",
)({
  version: Schema.Literal(1),
  planDigest: Schema.NonEmptyString,
  repository: Repository,
  environment: DeploymentEnvironment,
  applied: Schema.Array(Schema.NonEmptyString),
  secretVerification: Schema.Literal("presence-only"),
}) {}

type GitHubPlanRequest = {
  readonly repository: string;
  readonly project: string;
  readonly environment: string;
  readonly release: string;
  readonly rollout: string;
  readonly releaseVariable?: string;
  readonly sentryDsnVariable?: string;
};

type GitHubCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
};

type DeploymentConfiguration = {
  readonly variables: ReadonlyArray<readonly [string, string]>;
  readonly secrets: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>;
  readonly fingerprint: string;
};

const fingerprint = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const planPayload = (plan: Omit<GitHubEnvironmentPlan, "digest">): string =>
  JSON.stringify({
    version: plan.version,
    repository: plan.repository,
    project: plan.project,
    environment: plan.environment,
    release: plan.release,
    rollout: plan.rollout,
    releaseVariable: plan.releaseVariable,
    sentryDsnVariable: plan.sentryDsnVariable,
    observedFingerprint: plan.observedFingerprint,
    configurationFingerprint: plan.configurationFingerprint,
    protectionRules: plan.protectionRules,
    requiredReviewerIds: plan.requiredReviewerIds,
    preventSelfReview: plan.preventSelfReview,
    protectedBranches: plan.protectedBranches,
    customBranchPolicies: plan.customBranchPolicies,
    actions: plan.actions,
    sideEffects: plan.sideEffects,
  });

const commandFailure = (operation: string, exitCode: number): GitHubEnvironmentError =>
  new GitHubEnvironmentError({
    code: "OBS_CLI_GITHUB_COMMAND_FAILED",
    message: `GitHub operation ${operation} failed with exit code ${exitCode}. Verify gh authentication, repository access, and environment permissions before retrying.`,
    operation,
    retryable: true,
    cause: exitCode,
  });

const runGh = Effect.fn("GitHubEnvironment.runGh")(function* (
  operation: string,
  args: ReadonlyArray<string>,
  input: Option.Option<Redacted.Redacted<string>>,
): Effect.fn.Return<GitHubCommandResult, GitHubEnvironmentError> {
  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["gh", ...args], {
        stdin: Option.isSome(input) ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (Option.isSome(input)) {
        const stdin = child.stdin;
        if (stdin === undefined) {
          child.kill();
          return { exitCode: 127, stdout: "" };
        }
        await stdin.write(Redacted.value(input.value));
        await stdin.end();
      }
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout };
    },
    catch: (cause) =>
      new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_COMMAND_FAILED",
        message: `GitHub operation ${operation} could not start. Install gh and authenticate for the explicit repository.`,
        operation,
        retryable: true,
        cause,
      }),
  });
  if (result.exitCode !== 0) return yield* commandFailure(operation, result.exitCode);
  return result;
});

const parseResponse = Effect.fn("GitHubEnvironment.parseResponse")(function* <Value>(
  operation: string,
  content: string,
  decode: (input: Schema.Json) => Effect.Effect<Value, Schema.SchemaError>,
): Effect.fn.Return<Value, GitHubEnvironmentError> {
  const document = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(content)),
    catch: (cause) =>
      new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_RESPONSE_INVALID",
        message: `GitHub operation ${operation} returned invalid JSON.`,
        operation,
        retryable: true,
        cause,
      }),
  });
  return yield* decode(document).pipe(
    Effect.mapError(
      (cause) =>
        new GitHubEnvironmentError({
          code: "OBS_CLI_GITHUB_RESPONSE_INVALID",
          message: `GitHub operation ${operation} returned an incompatible response.`,
          operation,
          retryable: true,
          cause,
        }),
    ),
  );
});

const apiPath = (repository: string, environment: string, suffix = ""): string =>
  `repos/${repository}/environments/${encodeURIComponent(environment)}${suffix}`;

const observe = Effect.fn("GitHubEnvironment.observe")(function* (
  repository: string,
  environment: string,
) {
  const environmentResult = yield* runGh(
    "read-environment",
    ["api", apiPath(repository, environment)],
    Option.none(),
  ).pipe(
    Effect.catchTag("GitHubEnvironmentError", (error) =>
      error.code === "OBS_CLI_GITHUB_COMMAND_FAILED"
        ? Effect.fail(
            new GitHubEnvironmentError({
              code: "OBS_CLI_GITHUB_ENVIRONMENT_NOT_FOUND",
              message: `GitHub Environment ${environment} in ${repository} is unavailable. Create it with required reviewers and deployment protections before planning.`,
              operation: "read-environment",
              retryable: true,
              cause: error,
            }),
          )
        : Effect.fail(error),
    ),
  );
  const environmentDocument = yield* parseResponse(
    "read-environment",
    environmentResult.stdout,
    decodeEnvironmentResponse,
  );
  const variablesResult = yield* runGh(
    "list-variables",
    ["api", "--paginate", "--slurp", apiPath(repository, environment, "/variables?per_page=100")],
    Option.none(),
  );
  const secretsResult = yield* runGh(
    "list-secrets",
    ["api", "--paginate", "--slurp", apiPath(repository, environment, "/secrets?per_page=100")],
    Option.none(),
  );
  const variables = yield* parseResponse(
    "list-variables",
    variablesResult.stdout,
    decodeVariablesResponse,
  );
  const secrets = yield* parseResponse("list-secrets", secretsResult.stdout, decodeSecretsResponse);
  const variablePages = Array.isArray(variables) ? variables : [variables];
  const secretPages = Array.isArray(secrets) ? secrets : [secrets];
  const protectionRules = environmentDocument.protection_rules.map((rule) => rule.type).toSorted();
  const requiredReviewers = environmentDocument.protection_rules.find(
    (rule) => rule.type === "required_reviewers",
  );
  const requiredReviewerIds = (requiredReviewers?.reviewers ?? [])
    .map((entry) => entry.reviewer.id)
    .toSorted((left, right) => left - right);
  const preventSelfReview = requiredReviewers?.prevent_self_review ?? false;
  const protectedBranches =
    environmentDocument.deployment_branch_policy?.protected_branches ?? false;
  const customBranchPolicies =
    environmentDocument.deployment_branch_policy?.custom_branch_policies ?? false;
  const observed = {
    environmentId: environmentDocument.id,
    environmentName: environmentDocument.name,
    protectionRules,
    requiredReviewerIds,
    preventSelfReview,
    protectedBranches,
    customBranchPolicies,
    variables: variablePages
      .flatMap((page) => page.variables)
      .map((variable) => ({
        name: variable.name,
        value: variable.value,
        updatedAt: variable.updated_at,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    secrets: secretPages
      .flatMap((page) => page.secrets)
      .map((secret) => ({ name: secret.name, updatedAt: secret.updated_at }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  };
  return { ...observed, fingerprint: fingerprint(JSON.stringify(observed)) };
});

const deploymentConfiguration = Effect.fn("GitHubEnvironment.deploymentConfiguration")(function* (
  remote: RemoteEnvironment["Service"],
  credentialsStore: CredentialsStore["Service"],
  project: string,
  environment: string,
  release: string,
  rollout: typeof Rollout.Type,
  releaseVariable: string,
  sentryDsnVariable: string,
): Effect.fn.Return<
  DeploymentConfiguration,
  | GitHubEnvironmentError
  | import("./CredentialsStore.ts").CredentialsError
  | import("./RemoteEnvironment.ts").RemoteEnvironmentError
> {
  const credentials = Option.getOrElse(yield* credentialsStore.load(), emptyCredentials);
  if (
    (credentials.pendingAxiomMutations ?? []).some(
      (mutation) => mutation.project === project && mutation.environment === environment,
    )
  ) {
    return yield* new GitHubEnvironmentError({
      code: "OBS_CLI_GITHUB_INPUT_INVALID",
      message: `Provider mutation state for ${project}/${environment} is unresolved. Reconcile or rotate the ingestion token before GitHub synchronization.`,
      operation: "load-deployment-configuration",
      retryable: false,
      cause: `${project}/${environment}`,
    });
  }
  const configured = yield* remote.list(Option.some(project));
  const managed = configured.find((candidate) => candidate.environment === environment);
  if (managed === undefined) {
    return yield* new GitHubEnvironmentError({
      code: "OBS_CLI_GITHUB_INPUT_INVALID",
      message: `Configured remote environment ${project}/${environment} was not found. Complete provider provisioning before GitHub synchronization.`,
      operation: "load-deployment-configuration",
      retryable: true,
      cause: `${project}/${environment}`,
    });
  }
  const variables: Array<readonly [string, string]> = [
    ["OTEL_SERVICE_NAME", project],
    [releaseVariable, release],
    ["OTEL_DEPLOYMENT_ENVIRONMENT", environment],
    ["OBSERVABILITY_TELEMETRY_ROLLOUT", rollout],
  ];
  const secrets: Array<readonly [string, Redacted.Redacted<string>]> = [];
  const axiom = environmentAxiom(managed);
  if (Option.isSome(axiom)) {
    if (axiom.value.correlation.type !== "operator-confirmed") {
      return yield* new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_INPUT_INVALID",
        message: `Axiom Correlation for ${project}/${environment} still requires manual confirmation. Complete it before synchronizing deployment credentials.`,
        operation: "load-deployment-configuration",
        retryable: true,
        cause: `${project}/${environment}`,
      });
    }
    variables.push(
      ["OTEL_EXPORTER_OTLP_ENDPOINT", `http://${project}-otel-collector:4318`],
      ["AXIOM_DATASET_TRACES", axiom.value.tracesDataset],
      ["AXIOM_DATASET_LOGS", axiom.value.logsDataset],
      ["AXIOM_DATASET_METRICS", axiom.value.metricsDataset],
    );
    const edgeDeployment = axiom.value.datasets?.metrics.edgeDeployment;
    if (edgeDeployment === undefined) {
      return yield* new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_INPUT_INVALID",
        message: `Axiom edge deployment for ${project}/${environment} is not verified. Reapply the exact provider plan before GitHub synchronization.`,
        operation: "load-deployment-configuration",
        retryable: true,
        cause: `${project}/${environment}`,
      });
    }
    variables.push(["AXIOM_EDGE_DEPLOYMENT", edgeDeployment]);
    secrets.push(["AXIOM_TOKEN", Redacted.make(axiom.value.token)]);
  }
  const sentry = environmentSentry(managed);
  if (Option.isSome(sentry)) secrets.push([sentryDsnVariable, Redacted.make(sentry.value.dsn)]);
  return {
    variables,
    secrets,
    fingerprint: fingerprint(
      JSON.stringify({
        variables,
        secrets: secrets.map(([name, value]) => [name, fingerprint(Redacted.value(value))]),
      }),
    ),
  };
});

const parseRequest = Effect.fn("GitHubEnvironment.parseRequest")(function* (
  request: GitHubPlanRequest,
) {
  const mapInputError = (field: string) => (cause: Schema.SchemaError) =>
    new GitHubEnvironmentError({
      code: "OBS_CLI_GITHUB_INPUT_INVALID" as const,
      message: `GitHub deployment ${field} is invalid.`,
      operation: "parse-input",
      retryable: true,
      cause,
    });
  return {
    repository: yield* decodeRepository(request.repository).pipe(
      Effect.mapError(mapInputError("repository")),
    ),
    project: request.project,
    environment: yield* decodeDeploymentEnvironment(request.environment).pipe(
      Effect.mapError(mapInputError("environment")),
    ),
    release: yield* decodeRelease(request.release).pipe(Effect.mapError(mapInputError("release"))),
    rollout: yield* decodeRollout(request.rollout).pipe(Effect.mapError(mapInputError("rollout"))),
    releaseVariable: request.releaseVariable ?? "OTEL_SERVICE_VERSION",
    sentryDsnVariable: request.sentryDsnVariable ?? "SENTRY_DSN",
  };
});

const makePlan = Effect.fn("GitHubEnvironment.makePlan")(function* (
  remote: RemoteEnvironment["Service"],
  credentialsStore: CredentialsStore["Service"],
  request: GitHubPlanRequest,
) {
  const parsed = yield* parseRequest(request);
  const configuration = yield* deploymentConfiguration(
    remote,
    credentialsStore,
    parsed.project,
    parsed.environment,
    parsed.release,
    parsed.rollout,
    parsed.releaseVariable,
    parsed.sentryDsnVariable,
  );
  const observed = yield* observe(parsed.repository, parsed.environment);
  if (
    !observed.protectionRules.includes("required_reviewers") ||
    observed.requiredReviewerIds.length === 0 ||
    !observed.preventSelfReview ||
    (!observed.protectedBranches && !observed.customBranchPolicies)
  ) {
    return yield* new GitHubEnvironmentError({
      code: "OBS_CLI_GITHUB_INPUT_INVALID",
      message: `GitHub Environment ${parsed.environment} must require at least one reviewer, prevent self-review, and restrict deployment branches before planning.`,
      operation: "validate-environment-protection",
      retryable: true,
      cause: parsed.environment,
    });
  }
  const actions: Array<GitHubPlanAction> = [];
  const allowedVariables = new Set([...variableNames, parsed.releaseVariable]);
  const allowedSecrets = new Set([...secretNames, parsed.sentryDsnVariable]);
  for (const [name, value] of configuration.variables) {
    if (!allowedVariables.has(name)) continue;
    const current = observed.variables.find((candidate) => candidate.name === name);
    if (current?.value !== value) {
      actions.push(
        new GitHubPlanAction({
          kind: "set-variable",
          mode: current === undefined ? "create" : "update",
          name,
          value,
          effect:
            current === undefined
              ? "creates environment variable"
              : "overwrites environment variable",
        }),
      );
    }
  }
  for (const [name] of configuration.secrets) {
    if (!allowedSecrets.has(name)) continue;
    actions.push(
      new GitHubPlanAction({
        kind: "overwrite-secret",
        mode: "overwrite",
        name,
        effect: observed.secrets.some((candidate) => candidate.name === name)
          ? "overwrites environment secret; GitHub cannot prove existing secret equality"
          : "creates environment secret; GitHub will not expose its value for read-back",
      }),
    );
  }
  actions.sort((left, right) => left.name.localeCompare(right.name));
  const withoutDigest: Omit<GitHubEnvironmentPlan, "digest"> = {
    version: 1,
    repository: parsed.repository,
    project: parsed.project,
    environment: parsed.environment,
    release: parsed.release,
    rollout: parsed.rollout,
    releaseVariable: parsed.releaseVariable,
    sentryDsnVariable: parsed.sentryDsnVariable,
    observedFingerprint: observed.fingerprint,
    configurationFingerprint: configuration.fingerprint,
    protectionRules: observed.protectionRules,
    requiredReviewerIds: observed.requiredReviewerIds,
    preventSelfReview: observed.preventSelfReview,
    protectedBranches: observed.protectedBranches,
    customBranchPolicies: observed.customBranchPolicies,
    actions,
    sideEffects: [
      "Writes only allowlisted variables and secrets in the explicit GitHub Environment.",
      "Does not create or modify Environment protection rules, deploy applications, or approve rollout.",
      "Secret actions overwrite by name because GitHub never returns secret contents.",
    ],
  };
  return new GitHubEnvironmentPlan({
    ...withoutDigest,
    digest: fingerprint(planPayload(withoutDigest)),
  });
});

const decodePlan = Schema.decodeUnknownEffect(GitHubEnvironmentPlan, {
  onExcessProperty: "error",
});

const persistApplyState = Effect.fn("GitHubEnvironment.persistApplyState")(function* (
  directory: string,
  state: GitHubApplyState,
): Effect.fn.Return<void, GitHubEnvironmentError> {
  const path = resolve(directory, `github-apply-${state.planDigest}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
    catch: (cause) =>
      new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_STATE_FAILED",
        message: "GitHub apply recovery state could not be persisted securely.",
        operation: "persist-apply-state",
        retryable: false,
        cause,
      }),
  }).pipe(Effect.ensuring(Effect.promise(() => rm(temporary, { force: true }))));
});

const assertRecoverableScope = Effect.fn("GitHubEnvironment.assertRecoverableScope")(function* (
  directory: string,
  plan: GitHubEnvironmentPlan,
): Effect.fn.Return<void, GitHubEnvironmentError> {
  const entries = yield* Effect.tryPromise({
    try: () => readdir(directory),
    catch: (cause) =>
      new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_STATE_FAILED",
        message: "GitHub recovery directory could not be inspected.",
        operation: "read-apply-state",
        retryable: true,
        cause,
      }),
  });
  for (const entry of entries.filter(
    (name) => name.startsWith("github-apply-") && name.endsWith(".json"),
  )) {
    const content = yield* Effect.tryPromise({
      try: () => readFile(resolve(directory, entry), "utf8"),
      catch: (cause) =>
        new GitHubEnvironmentError({
          code: "OBS_CLI_GITHUB_STATE_FAILED",
          message: "GitHub recovery state could not be read safely.",
          operation: "read-apply-state",
          retryable: false,
          cause,
        }),
    });
    const state = yield* Schema.decodeUnknownEffect(GitHubApplyState, {
      onExcessProperty: "error",
    })(JSON.parse(content)).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubEnvironmentError({
            code: "OBS_CLI_GITHUB_STATE_FAILED",
            message: "GitHub recovery state is invalid and requires operator inspection.",
            operation: "read-apply-state",
            retryable: false,
            cause,
          }),
      ),
    );
    const unresolved = state.mutations.find((mutation) => mutation.status !== "completed");
    if (
      state.repository === plan.repository &&
      state.environment === plan.environment &&
      state.planDigest === plan.digest &&
      unresolved !== undefined
    ) {
      return yield* new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_APPLY_OUTCOME_UNKNOWN",
        message: `GitHub mutation ${unresolved.name} has durable state ${unresolved.status}. Re-observe the Environment and remove the recovery file only after reconciliation.`,
        operation: "recover-apply",
        retryable: false,
        cause: state.planDigest,
      });
    }
  }
});

const withScopeLock = <Value, Error, Requirements>(
  directory: string,
  repository: string,
  environment: string,
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error | GitHubEnvironmentError, Requirements> => {
  const scope = fingerprint(`${repository}\n${environment}`);
  const path = resolve(directory, `github-scope-${scope}.lock`);
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        return handle;
      },
      catch: (cause) =>
        new GitHubEnvironmentError({
          code: "OBS_CLI_GITHUB_STATE_FAILED",
          message: `Another GitHub apply owns the lock for ${repository}/${environment}. Wait for it to finish or recover the lock after proving the owner is gone.`,
          operation: "acquire-scope-lock",
          retryable: true,
          cause,
        }),
    }),
    () => effect,
    (handle) => Effect.promise(() => handle.close().then(() => rm(path, { force: true }))),
  );
};

export const encodeGitHubEnvironmentPlan = (plan: GitHubEnvironmentPlan): string =>
  `${JSON.stringify(plan, null, 2)}\n`;

export class GitHubEnvironment extends Context.Service<
  GitHubEnvironment,
  {
    plan(
      request: GitHubPlanRequest,
    ): Effect.Effect<
      GitHubEnvironmentPlan,
      | GitHubEnvironmentError
      | import("./CredentialsStore.ts").CredentialsError
      | import("./RemoteEnvironment.ts").RemoteEnvironmentError
    >;
    parsePlan(content: string): Effect.Effect<GitHubEnvironmentPlan, GitHubEnvironmentError>;
    apply(
      supplied: GitHubEnvironmentPlan,
      approveRollout: boolean,
      stateDirectory: string,
    ): Effect.Effect<
      GitHubApplyReceipt,
      | GitHubEnvironmentError
      | import("./CredentialsStore.ts").CredentialsError
      | import("./RemoteEnvironment.ts").RemoteEnvironmentError
    >;
  }
>()("@equipe-tech/observability-cli/GitHubEnvironment") {
  static readonly layer = Layer.effect(
    GitHubEnvironment,
    Effect.gen(function* () {
      const remote = yield* RemoteEnvironment;
      const credentialsStore = yield* CredentialsStore;
      const plan = (request: GitHubPlanRequest) => makePlan(remote, credentialsStore, request);
      const parsePlan = Effect.fn("GitHubEnvironment.parsePlan")(function* (content: string) {
        if (content.length > 1_048_576) {
          return yield* new GitHubEnvironmentError({
            code: "OBS_CLI_GITHUB_PLAN_INVALID",
            message: "The GitHub Environment plan exceeds 1048576 bytes.",
            operation: "parse-plan",
            retryable: true,
            cause: content.length,
          });
        }
        const document = yield* Effect.try({
          try: () => JSON.parse(content),
          catch: (cause) =>
            new GitHubEnvironmentError({
              code: "OBS_CLI_GITHUB_PLAN_INVALID",
              message: "The GitHub Environment plan is not valid JSON.",
              operation: "parse-plan",
              retryable: true,
              cause,
            }),
        });
        const decoded = yield* decodePlan(document).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubEnvironmentError({
                code: "OBS_CLI_GITHUB_PLAN_INVALID",
                message: "The GitHub Environment plan does not match version 1.",
                operation: "parse-plan",
                retryable: true,
                cause,
              }),
          ),
        );
        const expected = fingerprint(
          planPayload({
            version: decoded.version,
            repository: decoded.repository,
            project: decoded.project,
            environment: decoded.environment,
            release: decoded.release,
            rollout: decoded.rollout,
            releaseVariable: decoded.releaseVariable,
            sentryDsnVariable: decoded.sentryDsnVariable,
            observedFingerprint: decoded.observedFingerprint,
            configurationFingerprint: decoded.configurationFingerprint,
            protectionRules: decoded.protectionRules,
            requiredReviewerIds: decoded.requiredReviewerIds,
            preventSelfReview: decoded.preventSelfReview,
            protectedBranches: decoded.protectedBranches,
            customBranchPolicies: decoded.customBranchPolicies,
            actions: decoded.actions,
            sideEffects: decoded.sideEffects,
          }),
        );
        if (expected !== decoded.digest) {
          return yield* new GitHubEnvironmentError({
            code: "OBS_CLI_GITHUB_PLAN_INVALID",
            message: "The GitHub Environment plan digest does not match its contents.",
            operation: "parse-plan",
            retryable: true,
            cause: decoded.digest,
          });
        }
        return decoded;
      });
      const applyUnlocked = Effect.fn("GitHubEnvironment.applyUnlocked")(function* (
        supplied: GitHubEnvironmentPlan,
        approveRollout: boolean,
        stateDirectory: string,
      ) {
        if (supplied.rollout === "enabled" && !approveRollout) {
          return yield* new GitHubEnvironmentError({
            code: "OBS_CLI_GITHUB_ROLLOUT_APPROVAL_REQUIRED",
            message: `Rollout enablement requires --approve-rollout for exact plan ${supplied.digest}.`,
            operation: "apply",
            retryable: true,
            cause: supplied.digest,
          });
        }
        yield* assertRecoverableScope(stateDirectory, supplied);
        const current = yield* plan({
          repository: supplied.repository,
          project: supplied.project,
          environment: supplied.environment,
          release: supplied.release,
          rollout: supplied.rollout,
          releaseVariable: supplied.releaseVariable,
          sentryDsnVariable: supplied.sentryDsnVariable,
        });
        if (current.digest !== supplied.digest) {
          return yield* new GitHubEnvironmentError({
            code: "OBS_CLI_GITHUB_PLAN_STALE",
            message: `The GitHub Environment plan is stale. Run env github plan again. Current digest ${current.digest}.`,
            operation: "apply",
            retryable: true,
            cause: supplied.digest,
          });
        }
        const configuration = yield* deploymentConfiguration(
          remote,
          credentialsStore,
          supplied.project,
          supplied.environment,
          supplied.release,
          supplied.rollout,
          supplied.releaseVariable,
          supplied.sentryDsnVariable,
        );
        const allowedVariables = new Set([...variableNames, supplied.releaseVariable]);
        const allowedSecrets = new Set([...secretNames, supplied.sentryDsnVariable]);
        const applied: Array<string> = [];
        const mutations: Array<GitHubMutationState> = [];
        const saveMutation = Effect.fn("GitHubEnvironment.saveMutation")(function* (
          name: string,
          status: GitHubMutationState["status"],
        ) {
          const next = new GitHubMutationState({ name, status });
          const index = mutations.findIndex((mutation) => mutation.name === name);
          if (index < 0) mutations.push(next);
          else mutations[index] = next;
          yield* persistApplyState(
            stateDirectory,
            new GitHubApplyState({
              version: 1,
              planDigest: supplied.digest,
              repository: supplied.repository,
              environment: supplied.environment,
              mutations,
            }),
          );
        });
        for (const action of supplied.actions) {
          yield* saveMutation(action.name, "pending");
          if (action.kind === "set-variable") {
            const value = action.value;
            if (value === undefined || !allowedVariables.has(action.name)) {
              return yield* new GitHubEnvironmentError({
                code: "OBS_CLI_GITHUB_PLAN_INVALID",
                message: `Plan action ${action.name} is not an allowlisted variable write.`,
                operation: "apply",
                retryable: false,
                cause: action.name,
              });
            }
            const body = Redacted.make(JSON.stringify({ name: action.name, value }));
            yield* runGh(
              `set-variable-${action.name}`,
              [
                "api",
                "--method",
                action.mode === "create" ? "POST" : "PATCH",
                apiPath(
                  supplied.repository,
                  supplied.environment,
                  action.mode === "create"
                    ? "/variables"
                    : `/variables/${encodeURIComponent(action.name)}`,
                ),
                "--input",
                "-",
              ],
              Option.some(body),
            ).pipe(
              Effect.catchTag("GitHubEnvironmentError", (error) =>
                saveMutation(action.name, "outcome-unknown").pipe(
                  Effect.andThen(
                    Effect.fail(
                      new GitHubEnvironmentError({
                        code: "OBS_CLI_GITHUB_APPLY_OUTCOME_UNKNOWN",
                        message: `The outcome of GitHub variable mutation ${action.name} is unknown. Replan to reconcile before retrying.`,
                        operation: "apply",
                        retryable: false,
                        cause: error,
                      }),
                    ),
                  ),
                ),
              ),
            );
          } else {
            if (!allowedSecrets.has(action.name)) {
              return yield* new GitHubEnvironmentError({
                code: "OBS_CLI_GITHUB_PLAN_INVALID",
                message: `Plan action ${action.name} is not an allowlisted secret write.`,
                operation: "apply",
                retryable: false,
                cause: action.name,
              });
            }
            const secret = configuration.secrets.find(([name]) => name === action.name)?.[1];
            if (secret === undefined) {
              return yield* new GitHubEnvironmentError({
                code: "OBS_CLI_GITHUB_PLAN_INVALID",
                message: `Secret ${action.name} is unavailable from the configured environment.`,
                operation: "apply",
                retryable: true,
                cause: action.name,
              });
            }
            yield* runGh(
              `set-secret-${action.name}`,
              [
                "secret",
                "set",
                action.name,
                "--repo",
                supplied.repository,
                "--env",
                supplied.environment,
              ],
              Option.some(secret),
            ).pipe(
              Effect.catchTag("GitHubEnvironmentError", (error) =>
                saveMutation(action.name, "outcome-unknown").pipe(
                  Effect.andThen(
                    Effect.fail(
                      new GitHubEnvironmentError({
                        code: "OBS_CLI_GITHUB_APPLY_OUTCOME_UNKNOWN",
                        message: `The outcome of GitHub secret mutation ${action.name} is unknown. Replan and safely overwrite it before rollout.`,
                        operation: "apply",
                        retryable: false,
                        cause: error,
                      }),
                    ),
                  ),
                ),
              ),
            );
          }
          yield* saveMutation(action.name, "completed");
          applied.push(action.name);
        }
        const verified = yield* observe(supplied.repository, supplied.environment);
        for (const [name, value] of configuration.variables) {
          if (!allowedVariables.has(name)) continue;
          if (
            !verified.variables.some(
              (variable) => variable.name === name && variable.value === value,
            )
          ) {
            yield* saveMutation(name, "outcome-unknown");
            return yield* new GitHubEnvironmentError({
              code: "OBS_CLI_GITHUB_READBACK_FAILED",
              message: `GitHub variable ${name} did not match the exact planned value after write. Reconcile before deployment.`,
              operation: "verify-variable",
              retryable: false,
              cause: name,
            });
          }
        }
        for (const [name] of configuration.secrets) {
          if (!allowedSecrets.has(name)) continue;
          if (!verified.secrets.some((secret) => secret.name === name)) {
            yield* saveMutation(name, "outcome-unknown");
            return yield* new GitHubEnvironmentError({
              code: "OBS_CLI_GITHUB_READBACK_FAILED",
              message: `GitHub did not return metadata for secret ${name} after write. Secret equality remains unobservable; reconcile before deployment.`,
              operation: "verify-secret-metadata",
              retryable: false,
              cause: name,
            });
          }
        }
        if (
          JSON.stringify(verified.requiredReviewerIds) !==
            JSON.stringify(supplied.requiredReviewerIds) ||
          verified.preventSelfReview !== supplied.preventSelfReview ||
          verified.protectedBranches !== supplied.protectedBranches ||
          verified.customBranchPolicies !== supplied.customBranchPolicies
        ) {
          return yield* new GitHubEnvironmentError({
            code: "OBS_CLI_GITHUB_PLAN_STALE",
            message: "GitHub Environment protection changed during apply. Review a fresh plan.",
            operation: "verify-protection",
            retryable: true,
            cause: supplied.digest,
          });
        }
        return new GitHubApplyReceipt({
          version: 1,
          planDigest: supplied.digest,
          repository: supplied.repository,
          environment: supplied.environment,
          applied,
          secretVerification: "presence-only",
        });
      });
      const apply = (
        supplied: GitHubEnvironmentPlan,
        approveRollout: boolean,
        stateDirectory: string,
      ) =>
        withScopeLock(
          resolve(credentialsStore.path, "..", "github-locks"),
          supplied.repository,
          supplied.environment,
          applyUnlocked(supplied, approveRollout, stateDirectory),
        );
      return GitHubEnvironment.of({ plan, parsePlan, apply });
    }),
  );
}

export const persistGitHubEnvironmentPlan = Effect.fn("persistGitHubEnvironmentPlan")(function* (
  directory: string,
  plan: GitHubEnvironmentPlan,
): Effect.fn.Return<string, GitHubEnvironmentError> {
  const root = resolve(directory, ".observability");
  const path = resolve(root, `github-plan-${plan.digest}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await writeFile(temporary, encodeGitHubEnvironmentPlan(plan), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
    catch: (cause) =>
      new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_STATE_FAILED",
        message: "The GitHub Environment plan could not be persisted securely.",
        operation: "persist-plan",
        retryable: true,
        cause,
      }),
  }).pipe(Effect.ensuring(Effect.promise(() => rm(temporary, { force: true }))));
  return path;
});

export const readGitHubEnvironmentPlan = Effect.fn("readGitHubEnvironmentPlan")(function* (
  path: string,
): Effect.fn.Return<string, GitHubEnvironmentError> {
  return yield* Effect.tryPromise({
    try: () => readFile(resolve(path), "utf8"),
    catch: (cause) =>
      new GitHubEnvironmentError({
        code: "OBS_CLI_GITHUB_PLAN_INVALID",
        message: "Apply requires a readable file produced by env github plan.",
        operation: "read-plan",
        retryable: true,
        cause,
      }),
  });
});
