import { Console, Effect, Option, Path, Redacted } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { authenticationTokenFromEnvironment } from "./AuthenticationInput.ts";
import { DockerCompose } from "./DockerCompose.ts";
import {
  loadOperationsManifest,
  persistOperationsPlan,
  readOperationsPlan,
} from "./ManifestSource.ts";
import { encodeOperationsPlan, OperationsPlanner } from "./OperationsPlan.ts";
import { ProvisionAssets } from "./ProvisionAssets.ts";
import {
  Authentication,
  environmentAxiom,
  environmentProviderNames,
  environmentSentry,
  parseProviderSelection,
  RemoteEnvironment,
  validateRemoteProvisionRequest,
} from "./RemoteEnvironment.ts";
import { StackAssets } from "./StackAssets.ts";
import { SetupError, SetupGenerator, type SetupInputEncoded } from "./setup/SetupGenerator.ts";

const composeFile = Flag.string("file").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Caminho alternativo do docker-compose.yml da stack local"),
  Flag.optional,
);

const resolveComposeFile = Effect.fn("resolveComposeFile")(function* (file: Option.Option<string>) {
  if (Option.isSome(file)) {
    const path = yield* Path.Path;
    return path.resolve(file.value);
  }
  const assets = yield* StackAssets;
  return yield* assets.prepare();
});

const up = Command.make(
  "up",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    const resolvedFile = yield* resolveComposeFile(file);
    yield* compose.up(resolvedFile);
  }),
).pipe(Command.withDescription("Sobe a stack local (collector + viewer)"));

const down = Command.make(
  "down",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    const resolvedFile = yield* resolveComposeFile(file);
    yield* compose.down(resolvedFile);
  }),
).pipe(Command.withDescription("Derruba a stack local"));

const status = Command.make(
  "status",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    const resolvedFile = yield* resolveComposeFile(file);
    yield* compose.status(resolvedFile);
  }),
).pipe(Command.withDescription("Mostra o estado da stack local"));

const dev = Command.make("dev").pipe(
  Command.withSubcommands([up, down, status]),
  Command.withDescription("Ciclo de vida da stack local de observabilidade"),
);

const axiomOrganization = Flag.string("organization-id").pipe(
  Flag.withDescription("Identificador da organização Axiom"),
);
const authenticationTokenEnvironment = Flag.string("token-env").pipe(
  Flag.withDescription("Environment variable containing the provider token"),
  Flag.optional,
);

const authenticationToken = Effect.fn("authenticationToken")(function* (
  environment: Option.Option<string>,
  prompt: string,
) {
  if (Option.isSome(environment))
    return yield* authenticationTokenFromEnvironment(environment.value);
  return yield* Prompt.run(Prompt.password({ message: prompt }));
});

const authLoginAxiom = Command.make(
  "axiom",
  { organizationId: axiomOrganization, tokenEnvironment: authenticationTokenEnvironment },
  Effect.fn(function* ({ organizationId, tokenEnvironment }) {
    const token = yield* authenticationToken(tokenEnvironment, "Axiom personal access token");
    const authentication = yield* Authentication;
    const identity = yield* authentication.loginAxiom(Redacted.value(token), organizationId);
    yield* Console.log(`Authenticated with Axiom as ${identity}.`);
  }),
).pipe(Command.withDescription("Autentica com Axiom e salva as credenciais locais"));

const sentryOrganization = Flag.string("organization").pipe(
  Flag.withDescription("Slug da organização Sentry"),
);
const sentryTeam = Flag.string("team").pipe(Flag.withDescription("Slug do time Sentry"));
const sentryUrl = Flag.string("url").pipe(
  Flag.withDescription("URL base do Sentry"),
  Flag.withDefault("https://sentry.io"),
  Flag.mapTryCatch(
    (value) => new URL(value),
    () => "Expected an absolute Sentry URL",
  ),
);

const authLoginSentry = Command.make(
  "sentry",
  {
    organization: sentryOrganization,
    team: sentryTeam,
    url: sentryUrl,
    tokenEnvironment: authenticationTokenEnvironment,
  },
  Effect.fn(function* ({ organization, team, tokenEnvironment, url }) {
    const token = yield* authenticationToken(tokenEnvironment, "Sentry organization auth token");
    const authentication = yield* Authentication;
    const identity = yield* authentication.loginSentry(
      Redacted.value(token),
      organization,
      team,
      url,
    );
    yield* Console.log(`Authenticated with Sentry organization ${identity}.`);
  }),
).pipe(Command.withDescription("Autentica com Sentry e salva as credenciais locais"));

const authLogin = Command.make("login").pipe(
  Command.withSubcommands([authLoginAxiom, authLoginSentry]),
  Command.withDescription("Salva credenciais após validar o acesso ao provider"),
);

const authStatus = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const authentication = yield* Authentication;
    const result = yield* authentication.status();
    yield* Console.log(`Axiom: ${result.axiom}`);
    yield* Console.log(`Sentry: ${result.sentry}`);
    yield* Console.log(`Credentials: ${result.credentialsPath}`);
  }),
).pipe(Command.withDescription("Valida as credenciais salvas"));

const auth = Command.make("auth").pipe(
  Command.withSubcommands([authLogin, authStatus]),
  Command.withDescription("Gerencia autenticação com os providers"),
);

const provisionDirectory = Flag.string("dir").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Diretório do projeto alvo (padrão: diretório atual)"),
  Flag.withDefault("."),
);

const provisionName = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Nome do projeto usado nos datasets (padrão: nome do diretório alvo)"),
  Flag.optional,
);

const provisionForce = Flag.boolean("force").pipe(
  Flag.withDescription("Sobrescreve arquivos provisionados que foram modificados"),
  Flag.withDefault(false),
);

const provisionEnvironments = Flag.string("environment").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Ambiente remoto. Repita a flag para configurar vários ambientes"),
  Flag.atMost(10),
);

const provisionProviders = Flag.string("provider").pipe(
  Flag.withDescription("Provider remoto. Use axiom ou sentry e repita para selecionar ambos"),
  Flag.atMost(10),
);

const provisionPlatform = Flag.string("sentry-platform").pipe(
  Flag.withDescription("Plataforma do projeto Sentry"),
  Flag.withDefault("node"),
);

const provisionRotateToken = Flag.boolean("rotate-token").pipe(
  Flag.withDescription("Regenera o token de ingestão Axiom de cada ambiente"),
  Flag.withDefault(false),
);

const provisionAxiomEdgeDeployment = Flag.string("axiom-edge-deployment").pipe(
  Flag.withDescription("Identificador do edge deployment Axiom para os datasets"),
  Flag.optional,
);

const provisionAxiomRetentionDays = Flag.integer("axiom-retention-days").pipe(
  Flag.withDescription("Retenção Axiom explícita em dias positivos"),
  Flag.optional,
);

const provisionCorrelationConfirmed = Flag.boolean("correlation-confirmed").pipe(
  Flag.withDescription("Confirma que o grupo de correlação salvo foi criado no Console Axiom"),
  Flag.withDefault(false),
);

const provision = Command.make(
  "provision",
  {
    dir: provisionDirectory,
    name: provisionName,
    force: provisionForce,
    environments: provisionEnvironments,
    providers: provisionProviders,
    platform: provisionPlatform,
    rotateToken: provisionRotateToken,
    axiomEdgeDeployment: provisionAxiomEdgeDeployment,
    axiomRetentionDays: provisionAxiomRetentionDays,
    correlationConfirmed: provisionCorrelationConfirmed,
  },
  Effect.fn(function* ({
    axiomEdgeDeployment,
    axiomRetentionDays,
    correlationConfirmed,
    dir,
    environments,
    force,
    name,
    platform,
    providers,
    rotateToken,
  }) {
    const selectedProviders = yield* parseProviderSelection(providers);
    const assets = yield* ProvisionAssets;
    const projectName = yield* assets.resolveName(dir, name);
    const uniqueEnvironments = [...new Set(environments)];
    if (uniqueEnvironments.length > 0) {
      yield* validateRemoteProvisionRequest(projectName, uniqueEnvironments);
    }
    const files = yield* assets.provision(dir, Option.some(projectName), force);
    for (const file of files) {
      yield* Console.log(`${file.action}  ${file.relativePath}`);
    }

    if (uniqueEnvironments.length === 0) {
      yield* Console.log(
        "Merge observability/kamal.accessory.yml into config/deploy.yml and set the AXIOM_TOKEN secret.",
      );
      return;
    }

    const remote = yield* RemoteEnvironment;
    const configured = yield* remote.provision(
      projectName,
      uniqueEnvironments,
      selectedProviders,
      platform,
      rotateToken,
      Option.getOrUndefined(axiomEdgeDeployment),
      Option.getOrUndefined(axiomRetentionDays),
      correlationConfirmed,
    );
    for (const environment of configured) {
      const providerNames = environmentProviderNames(environment).join(",");
      const parts = [
        `configured  ${environment.project}/${environment.environment}`,
        `providers=${providerNames}`,
      ];
      const axiom = environmentAxiom(environment);
      if (Option.isSome(axiom)) {
        parts.push(
          `datasets=${axiom.value.tracesDataset},${axiom.value.logsDataset},${axiom.value.metricsDataset}`,
        );
      }
      const sentry = environmentSentry(environment);
      if (Option.isSome(sentry)) {
        parts.push(`sentry-project=${sentry.value.project}`);
      }
      yield* Console.log(parts.join("  "));
      if (Option.isSome(axiom) && axiom.value.correlation.type === "manual-required") {
        yield* Console.log(
          `manual-action  Open the Axiom Console and create Correlation group "${axiom.value.correlation.groupName}" with slug "${axiom.value.correlation.groupSlug}".`,
        );
        yield* Console.log(
          `manual-action  Select traces dataset ${axiom.value.correlation.tracesDataset}, logs dataset ${axiom.value.correlation.logsDataset}, and metrics dataset ${axiom.value.correlation.metricsDataset}.`,
        );
        yield* Console.log(
          "manual-action  Save the group, then rerun this command with --correlation-confirmed. The CLI cannot verify the group through a stable public Axiom API.",
        );
      }
    }
    if (configured.some((environment) => Option.isSome(environmentAxiom(environment)))) {
      yield* Console.log(
        "Merge observability/kamal.accessory.yml into config/deploy.yml and set the AXIOM_TOKEN secret.",
      );
    } else {
      yield* Console.log(
        "The generated Collector assets require Axiom variables and are not configured by this Sentry-only command.",
      );
    }
    yield* Console.log(
      `Run observability env export --name ${projectName} --environment <environment> --release <version> to print deploy variables.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Provisiona os assets locais e, com --environment, os providers remotos selecionados",
  ),
);

const environmentProject = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Nome do projeto"),
  Flag.optional,
);

const environmentList = Command.make(
  "list",
  { name: environmentProject },
  Effect.fn(function* ({ name }) {
    const remote = yield* RemoteEnvironment;
    const environments = yield* remote.list(name);
    if (environments.length === 0) {
      yield* Console.log("No configured environments.");
      return;
    }
    for (const environment of environments) {
      const parts = [`${environment.project}/${environment.environment}`];
      const axiom = environmentAxiom(environment);
      if (Option.isSome(axiom)) {
        parts.push(
          `axiom=${axiom.value.tracesDataset},${axiom.value.logsDataset},${axiom.value.metricsDataset}`,
        );
      }
      const sentry = environmentSentry(environment);
      if (Option.isSome(sentry)) {
        parts.push(`sentry=${sentry.value.project}`);
      }
      yield* Console.log(parts.join("  "));
    }
  }),
).pipe(Command.withDescription("Lista os ambientes configurados por esta CLI"));

const environmentExportName = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Nome do projeto"),
);
const environmentExportEnvironment = Flag.string("environment").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Nome do ambiente"),
);
const environmentExportRelease = Flag.string("release").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Versão SemVer ou identificador imutável da release"),
);

const environmentExport = Command.make(
  "export",
  {
    name: environmentExportName,
    environment: environmentExportEnvironment,
    release: environmentExportRelease,
  },
  Effect.fn(function* ({ environment, name, release }) {
    const remote = yield* RemoteEnvironment;
    yield* Console.log(yield* remote.export(name, environment, release));
  }),
).pipe(Command.withDescription("Imprime variáveis de deploy no formato dotenv"));

const environment = Command.make("env").pipe(
  Command.withSubcommands([environmentList, environmentExport]),
  Command.withDescription("Inspeciona e exporta ambientes configurados"),
);

const operationsDirectory = Flag.string("dir").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Diretório do projeto que contém observability/operations.yaml"),
  Flag.withDefault("."),
);
const operationsEnvironments = Flag.string("environment").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Ambiente declarado no manifesto. Repita para selecionar vários"),
  Flag.atMost(20),
);
const operationsJson = Flag.boolean("json").pipe(
  Flag.withDescription("Emite o resultado como JSON sem queries ou credenciais"),
  Flag.withDefault(false),
);
const operationsPlanFile = Flag.string("plan").pipe(
  Flag.withDescription("Arquivo exato produzido por ops plan"),
);
const operationsAllowDestructive = Flag.boolean("allow-destructive").pipe(
  Flag.withDescription("Autoriza somente as mudanças destrutivas do digest do plano fornecido"),
  Flag.withDefault(false),
);
const operationsConfirmedManualActions = Flag.string("confirm-manual").pipe(
  Flag.withDescription("Confirma pelo ID uma ação manual contida no plano exato"),
  Flag.atMost(100),
);

const printPlan = Effect.fn("printOperationsPlan")(function* (
  plan: import("./OperationsPlan.ts").OperationsPlanDocument,
  json: boolean,
) {
  if (json) {
    yield* Console.log(encodeOperationsPlan(plan).trimEnd());
    return;
  }
  for (const action of plan.actions) {
    yield* Console.log(`${action.kind}  ${action.capability}  ${action.resource}`);
  }
  yield* Console.log(
    `plan ${plan.digest}  changes=${plan.actions.length}  manual-pending=${plan.pendingManualActions.length}`,
  );
});

const operationsPlan = Command.make(
  "plan",
  { dir: operationsDirectory, environments: operationsEnvironments, json: operationsJson },
  Effect.fn(function* ({ dir, environments, json }) {
    const validated = yield* loadOperationsManifest(dir);
    const planner = yield* OperationsPlanner;
    const plan = yield* planner.plan({ validated, environments });
    yield* persistOperationsPlan(dir, plan.digest, encodeOperationsPlan(plan));
    yield* printPlan(plan, json);
  }),
).pipe(Command.withDescription("Lê providers e grava um plano determinístico sem mutações"));

const operationsApply = Command.make(
  "apply",
  {
    dir: operationsDirectory,
    environments: operationsEnvironments,
    json: operationsJson,
    plan: operationsPlanFile,
    allowDestructive: operationsAllowDestructive,
    confirmedManualActions: operationsConfirmedManualActions,
  },
  Effect.fn(function* ({
    allowDestructive,
    confirmedManualActions,
    dir,
    environments,
    json,
    plan: planPath,
  }) {
    const validated = yield* loadOperationsManifest(dir);
    const planner = yield* OperationsPlanner;
    const content = yield* readOperationsPlan(planPath);
    const supplied = yield* planner.parsePlan(content);
    const result = yield* planner.apply(
      { validated, environments },
      supplied,
      allowDestructive,
      confirmedManualActions,
    );
    yield* printPlan(result, json);
  }),
).pipe(Command.withDescription("Aplica somente um plano exato e executa read-back limitado"));

const operationsVerify = Command.make(
  "verify",
  { dir: operationsDirectory, environments: operationsEnvironments, json: operationsJson },
  Effect.fn(function* ({ dir, environments, json }) {
    const validated = yield* loadOperationsManifest(dir);
    const planner = yield* OperationsPlanner;
    const plan = yield* planner.verify({ validated, environments });
    yield* printPlan(plan, json);
  }),
).pipe(Command.withDescription("Verifica drift, mutações pendentes e ações manuais sem escrever"));

const operations = Command.make("ops").pipe(
  Command.withSubcommands([operationsPlan, operationsApply, operationsVerify]),
  Command.withDescription("Reconcilia o manifesto versionado de operações"),
);

const setupDirectory = Flag.string("dir").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Application directory"),
  Flag.withDefault("."),
);
const setupProfile = Flag.string("profile").pipe(Flag.withDescription("Official profile"));
const setupServiceName = Flag.string("service-name").pipe(Flag.optional);
const setupEnvironments = Flag.string("environment").pipe(Flag.atMost(20));
const setupOtlpEndpoint = Flag.string("otlp-endpoint").pipe(Flag.optional);
const setupPublicOrigin = Flag.string("public-origin").pipe(Flag.optional);
const setupIngestPath = Flag.string("ingest-path").pipe(Flag.withDefault("_telemetry/events"));
const setupProxyPolicy = Flag.string("proxy-policy").pipe(Flag.withDefault("direct"));
const setupSentryDsnVariable = Flag.string("sentry-dsn-variable").pipe(
  Flag.withDefault("SENTRY_DSN"),
);
const setupReleaseVariable = Flag.string("release-variable").pipe(
  Flag.withDefault("OTEL_SERVICE_VERSION"),
);
const setupAxiomOrganization = Flag.string("axiom-organization-id").pipe(Flag.optional);
const setupSentryOrganization = Flag.string("sentry-org").pipe(Flag.optional);
const setupSentryTeam = Flag.string("sentry-team").pipe(Flag.optional);
const setupSentryProject = Flag.string("sentry-project").pipe(Flag.optional);
const setupSourceMapBuildScript = Flag.string("source-map-build-script").pipe(Flag.optional);
const setupSourceMapPaths = Flag.string("source-map-path").pipe(Flag.atMost(20));
const setupBrowserIngest = Flag.boolean("with-browser-ingest").pipe(Flag.withDefault(false));
const setupDefects = Flag.boolean("with-defects").pipe(Flag.withDefault(false));
const setupMetrics = Flag.boolean("with-metrics").pipe(Flag.withDefault(false));
const setupForce = Flag.boolean("force").pipe(Flag.withDefault(false));
const setupInstall = Flag.boolean("install").pipe(
  Flag.withDescription("Installs exactly the selected profile packages with Bun"),
  Flag.withDefault(false),
);

const setupOptions = {
  dir: setupDirectory,
  profile: setupProfile,
  serviceName: setupServiceName,
  environments: setupEnvironments,
  otlpEndpoint: setupOtlpEndpoint,
  publicOrigin: setupPublicOrigin,
  ingestPath: setupIngestPath,
  proxyPolicy: setupProxyPolicy,
  sentryDsnVariable: setupSentryDsnVariable,
  releaseVariable: setupReleaseVariable,
  axiomOrganizationId: setupAxiomOrganization,
  sentryOrganization: setupSentryOrganization,
  sentryTeam: setupSentryTeam,
  sentryProject: setupSentryProject,
  sourceMapBuildScript: setupSourceMapBuildScript,
  sourceMapPaths: setupSourceMapPaths,
  browserIngest: setupBrowserIngest,
  defects: setupDefects,
  metrics: setupMetrics,
};

const setupInput = (options: {
  readonly profile: string;
  readonly serviceName: Option.Option<string>;
  readonly environments: ReadonlyArray<string>;
  readonly otlpEndpoint: Option.Option<string>;
  readonly publicOrigin: Option.Option<string>;
  readonly ingestPath: string;
  readonly proxyPolicy: string;
  readonly sentryDsnVariable: string;
  readonly releaseVariable: string;
  readonly axiomOrganizationId: Option.Option<string>;
  readonly sentryOrganization: Option.Option<string>;
  readonly sentryTeam: Option.Option<string>;
  readonly sentryProject: Option.Option<string>;
  readonly sourceMapBuildScript: Option.Option<string>;
  readonly sourceMapPaths: ReadonlyArray<string>;
  readonly browserIngest: boolean;
  readonly defects: boolean;
  readonly metrics: boolean;
}): SetupInputEncoded => ({
  profile: options.profile,
  serviceName: Option.getOrUndefined(options.serviceName),
  environments: [...options.environments],
  otlpEndpoint: Option.getOrUndefined(options.otlpEndpoint),
  publicOrigin: Option.getOrUndefined(options.publicOrigin),
  ingestPath: options.ingestPath,
  proxyPolicy: options.proxyPolicy,
  sentryDsnVariable: options.sentryDsnVariable,
  releaseVariable: options.releaseVariable,
  axiomOrganizationId: Option.getOrUndefined(options.axiomOrganizationId),
  sentryOrganization: Option.getOrUndefined(options.sentryOrganization),
  sentryTeam: Option.getOrUndefined(options.sentryTeam),
  sentryProject: Option.getOrUndefined(options.sentryProject),
  sourceMapBuildScript: Option.getOrUndefined(options.sourceMapBuildScript),
  sourceMapPaths: [...options.sourceMapPaths],
  browserIngest: options.browserIngest || options.profile === "react-web",
  defects: options.defects,
  metrics: options.metrics || options.profile === "nestjs-api" || options.profile === "worker",
});

const printSetupFiles = Effect.fn("printSetupFiles")(function* (
  files: ReadonlyArray<{ readonly action: string; readonly path: string }>,
) {
  for (const file of files) yield* Console.log(`${file.action}  ${file.path}`);
});

const printSetupTarget = Effect.fn("printSetupTarget")(function* (target: {
  readonly requestedDirectory: string;
  readonly directory: string;
}) {
  yield* Console.log(`target  requested  ${target.requestedDirectory}`);
  yield* Console.log(`target  canonical  ${target.directory}`);
});

const setupPlan = Command.make(
  "plan",
  setupOptions,
  Effect.fn(function* (options) {
    const generator = yield* SetupGenerator;
    const plan = yield* generator.plan(options.dir, setupInput(options));
    yield* printSetupTarget(plan);
    yield* printSetupFiles(plan.files);
    yield* Console.log(
      `packages  ${plan.dependencies.map((dependency) => dependency.installSpec).join(",")}`,
    );
    yield* Console.log("step  filesystem  no writes");
    yield* Console.log("step  providers  no reads or mutations");
  }),
).pipe(Command.withDescription("Plans application composition without writing"));

const setupWrite = Command.make(
  "write",
  { ...setupOptions, force: setupForce, install: setupInstall },
  Effect.fn(function* (options) {
    const generator = yield* SetupGenerator;
    const plan = yield* generator.write(
      options.dir,
      setupInput(options),
      options.force,
      options.install,
    );
    yield* printSetupTarget(plan);
    yield* printSetupFiles(plan.files);
    if (options.install) {
      const installed = yield* generator.install(plan);
      yield* Console.log(`step  ${installed.name}  ${installed.status}  ${installed.detail}`);
    } else {
      yield* Console.log(
        "step  dependencies  blocked  package installation requires explicit --install",
      );
    }
    yield* Console.log("step  filesystem  application files written explicitly");
    yield* Console.log("step  providers  no reads or mutations");
  }),
).pipe(Command.withDescription("Writes application composition after atomic conflict checks"));

const setupVerifyRelease = Command.make(
  "verify-release",
  { dir: setupDirectory, json: Flag.boolean("json").pipe(Flag.withDefault(false)) },
  Effect.fn(function* ({ dir, json }) {
    const generator = yield* SetupGenerator;
    const report = yield* generator.verifyRelease(dir);
    if (json) yield* Console.log(JSON.stringify(report));
    else {
      yield* printSetupTarget(report);
      for (const step of report.steps)
        yield* Console.log(`step  ${step.name}  ${step.status}  ${step.detail}`);
    }
    if (!report.passed)
      return yield* new SetupError({
        code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
        message:
          "Release prerequisites are blocked. Correct the application manifest, installed uploader, and declared source-map artifacts before retrying.",
        retryable: true,
        cause: report,
      });
  }),
).pipe(Command.withDescription("Verifies local release uploader and source-map artifacts"));

const setupVerifyEnvironment = Flag.string("environment").pipe(Flag.optional);
const setupReconcile = Flag.boolean("reconcile").pipe(Flag.withDefault(false));
const setupConform = Flag.boolean("conform").pipe(Flag.withDefault(false));
const setupJson = Flag.boolean("json").pipe(Flag.withDefault(false));
const setupProviderRead = Flag.boolean("provider-read").pipe(
  Flag.withDescription("Runs read-only provider reconciliation with application credentials"),
  Flag.withDefault(false),
);
const setupVerifyTarget = Flag.string("target").pipe(Flag.withDefault("local"));
const setupVerify = Command.make(
  "verify",
  {
    dir: setupDirectory,
    environment: setupVerifyEnvironment,
    reconcile: setupReconcile,
    conform: setupConform,
    json: setupJson,
    providerRead: setupProviderRead,
    target: setupVerifyTarget,
  },
  Effect.fn(function* ({ conform, dir, environment, json, providerRead, reconcile, target }) {
    if (target !== "local" && target !== "deployed")
      return yield* new SetupError({
        code: "OBS_SETUP_INPUT_INVALID",
        message: "Setup verification target must be local or deployed.",
        cause: target,
      });
    const generator = yield* SetupGenerator;
    const report = yield* generator.verify(
      dir,
      Option.getOrUndefined(environment),
      reconcile,
      conform,
      providerRead,
      target,
    );
    if (json) yield* Console.log(JSON.stringify(report));
    else {
      yield* printSetupTarget(report);
      for (const step of report.steps)
        yield* Console.log(`step  ${step.name}  ${step.status}  ${step.detail}`);
    }
    if (!report.passed) {
      return yield* new SetupError({
        code: "OBS_SETUP_CONFORMANCE_FAILED",
        message:
          "Setup verification did not pass every applicable local gate. Resolve failed and blocked steps before release.",
        cause: report,
      });
    }
  }),
).pipe(Command.withDescription("Verifies generated files and explicit application conformance"));

const setup = Command.make("setup").pipe(
  Command.withSubcommands([setupPlan, setupWrite, setupVerify, setupVerifyRelease]),
  Command.withDescription("Assembles applications from official observability profiles"),
);

export const observability = Command.make("observability").pipe(
  Command.withSubcommands([dev, auth, provision, environment, operations, setup]),
  Command.withDescription("Plataforma de observabilidade da Equipe Tech"),
);
