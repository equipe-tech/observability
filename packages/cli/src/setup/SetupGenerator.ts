import { Context, Effect, Layer, Schema } from "effect";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { observabilityProfiles, type ProfileName } from "@equipe-tech/observability";
import { EnvironmentName, ServiceName } from "../ResourceNamePolicy.ts";

const ProfileNameSchema = Schema.Literals([
  "nestjs-api",
  "worker",
  "react-web",
  "cli",
  "library",
] as const);
const VariableName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/));
const IngestPath = Schema.String.check(Schema.isPattern(/^\/?[A-Za-z0-9._~/-]+$/));
const ProxyPolicy = Schema.Literals(["direct", "framework"] as const);
const ProviderIdentifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/));
const PackageScriptName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/));
const ApplicationRelativePath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !isAbsolute(value) &&
      !value.startsWith("-") &&
      /^[A-Za-z0-9._/-]+$/.test(value) &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    { expected: "a safe application-relative path" },
  ),
);
const SourceMapBuildDocument = Schema.Struct({
  script: PackageScriptName,
  includePaths: Schema.NonEmptyArray(ApplicationRelativePath),
});
const SetupInputDocument = Schema.Struct({
  profile: ProfileNameSchema,
  serviceName: Schema.optional(ServiceName),
  environments: Schema.Array(EnvironmentName),
  otlpEndpoint: Schema.optional(Schema.URLFromString),
  publicOrigin: Schema.optional(Schema.URLFromString),
  ingestPath: IngestPath,
  proxyPolicy: ProxyPolicy,
  sentryDsnVariable: VariableName,
  releaseVariable: VariableName,
  axiomOrganizationId: Schema.optional(ProviderIdentifier),
  sentryOrganization: Schema.optional(ProviderIdentifier),
  sentryTeam: Schema.optional(ProviderIdentifier),
  sentryProject: Schema.optional(ProviderIdentifier),
  sourceMapBuild: Schema.optional(SourceMapBuildDocument),
  browserIngest: Schema.Boolean,
  defects: Schema.Boolean,
  metrics: Schema.Boolean,
});

export type SetupInput = typeof SetupInputDocument.Type;
export type SetupInputEncoded = {
  readonly profile: string;
  readonly serviceName: string | undefined;
  readonly environments: ReadonlyArray<string>;
  readonly otlpEndpoint: string | undefined;
  readonly publicOrigin: string | undefined;
  readonly ingestPath: string;
  readonly proxyPolicy: string;
  readonly sentryDsnVariable: string;
  readonly releaseVariable: string;
  readonly axiomOrganizationId: string | undefined;
  readonly sentryOrganization: string | undefined;
  readonly sentryTeam: string | undefined;
  readonly sentryProject: string | undefined;
  readonly sourceMapBuildScript: string | undefined;
  readonly sourceMapPaths: ReadonlyArray<string>;
  readonly browserIngest: boolean;
  readonly defects: boolean;
  readonly metrics: boolean;
};
export type SetupFileOwnership = "skill-owned" | "user-preserved";
export type SetupFileAction = "create" | "unchanged" | "conflict" | "preserved" | "updated";
export type SetupPlannedFile = {
  readonly path: string;
  readonly content: string;
  readonly ownership: SetupFileOwnership;
  readonly action: SetupFileAction;
  readonly recorded: boolean;
};
const SetupTarget = Schema.Struct({
  requestedDirectory: Schema.String,
  directory: Schema.String,
});
type SetupTarget = typeof SetupTarget.Type;

export type SetupDependency = {
  readonly name: string;
  readonly installSpec: string;
};
export type SetupPlan = SetupTarget & {
  readonly input: SetupInput;
  readonly packages: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<SetupDependency>;
  readonly files: ReadonlyArray<SetupPlannedFile>;
};
export type SetupVerificationStep = {
  readonly name:
    | "contract"
    | "dependencies"
    | "providers"
    | "conformance"
    | "browser-route"
    | "sentry";
  readonly status: "passed" | "failed" | "blocked" | "not-applicable";
  readonly detail: string;
  readonly exitCode?: number;
};
export type SetupVerificationReport = SetupTarget & {
  readonly profile: ProfileName;
  readonly filesystemEffects: ReadonlyArray<string>;
  readonly providerReads: ReadonlyArray<string>;
  readonly providerMutations: readonly [];
  readonly steps: ReadonlyArray<SetupVerificationStep>;
  readonly passed: boolean;
};
export type ReleasePrerequisiteStep = {
  readonly name: "declaration" | "uploader" | "artifacts";
  readonly status: "passed" | "blocked" | "not-applicable";
  readonly detail: string;
};
export type ReleasePrerequisiteReport = SetupTarget & {
  readonly steps: ReadonlyArray<ReleasePrerequisiteStep>;
  readonly passed: boolean;
};

const DecisionFile = Schema.Struct({
  path: Schema.String,
  ownership: Schema.Literals(["skill-owned", "user-preserved"]),
  digest: Schema.String,
});
const LegacySetupInputDocument = Schema.Struct({
  profile: ProfileNameSchema,
  serviceName: Schema.optional(ServiceName),
  environments: Schema.Array(EnvironmentName),
  otlpEndpoint: Schema.optional(Schema.URLFromString),
  publicOrigin: Schema.optional(Schema.URLFromString),
  ingestPath: IngestPath,
  proxyPolicy: ProxyPolicy,
  sentryDsnVariable: VariableName,
  releaseVariable: VariableName,
  sentryOrganization: Schema.optional(Schema.NonEmptyString),
  sentryProject: Schema.optional(Schema.NonEmptyString),
  pipeline: Schema.Literal("github-actions"),
  browserIngest: Schema.Boolean,
  defects: Schema.Boolean,
  metrics: Schema.Boolean,
});
const DecisionRecordV1 = Schema.Struct({
  version: Schema.Literal(1),
  target: Schema.optional(SetupTarget),
  profile: ProfileNameSchema,
  input: LegacySetupInputDocument,
  packages: Schema.Array(Schema.String),
  files: Schema.Array(DecisionFile),
});
const SetupDependencyDocument = Schema.Struct({
  name: Schema.String,
  installSpec: Schema.String,
});
const DecisionRecordV2 = Schema.Struct({
  version: Schema.Literal(2),
  target: Schema.optional(SetupTarget),
  profile: ProfileNameSchema,
  input: SetupInputDocument,
  packages: Schema.Array(Schema.String),
  dependencies: Schema.Array(SetupDependencyDocument),
  files: Schema.Array(DecisionFile),
});
type DecisionRecordV1 = typeof DecisionRecordV1.Type;
type DecisionRecordV2 = typeof DecisionRecordV2.Type;
type DecisionRecord = DecisionRecordV1 | DecisionRecordV2;
const decodeDecisionRecord = Schema.decodeUnknownPromise(
  Schema.Union([DecisionRecordV1, DecisionRecordV2]),
  { onExcessProperty: "error" },
);
const decodeSetupInput = Schema.decodeUnknownEffect(SetupInputDocument, {
  onExcessProperty: "error",
});

export class SetupError extends Schema.TaggedError<SetupError>()("SetupError", {
  code: Schema.Literals([
    "OBS_SETUP_PROFILE_INVALID",
    "OBS_SETUP_INPUT_MISSING",
    "OBS_SETUP_INPUT_INVALID",
    "OBS_SETUP_CONFLICT",
    "OBS_SETUP_RECONCILE_FAILED",
    "OBS_SETUP_CONFORMANCE_FAILED",
    "OBS_SETUP_FORBIDDEN_OUTPUT",
    "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
  ]),
  message: Schema.String,
  requestId: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.sync(() => crypto.randomUUID())),
  ),
  retryable: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  cause: Schema.Defect(),
}) {}

const fail = (code: SetupError["code"], message: string, cause: unknown): SetupError =>
  new SetupError({ code, message, cause });

const digest = (content: string): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");
const json = <Value>(value: Value): string => `${JSON.stringify(value, undefined, 2)}\n`;
const optional = <Value>(value: Value | undefined): Value | null => value ?? null;
const ForbiddenSecret =
  /sntrys_|bearer\s+[a-z0-9._~+/-]+=*|https:\/\/[^\s"']+@|[?&#](?:api[_-]?key|token|secret|password)=/i;

export const sentryCliDependency = {
  name: "@sentry/cli",
  installSpec: "@sentry/cli@3.7.0",
} satisfies SetupDependency;

const dependenciesFor = (input: SetupInput): ReadonlyArray<SetupDependency> => {
  const packages = new Set<string>([
    "@equipe-tech/observability",
    "@equipe-tech/observability-cli",
  ]);
  if (input.profile === "nestjs-api") packages.add("@equipe-tech/observability-nestjs");
  if (input.profile === "worker" || input.profile === "cli" || input.profile === "nestjs-api")
    packages.add("@equipe-tech/observability-evlog");
  if (input.profile === "react-web" || input.browserIngest)
    packages.add("@equipe-tech/observability-react");
  if (input.profile === "react-web") {
    packages.add("@equipe-tech/observability-sentry");
    packages.add("@sentry/browser");
  }
  if (input.defects) {
    packages.add("@equipe-tech/observability-sentry");
    packages.add(input.profile === "react-web" ? "@sentry/browser" : "@sentry/node-core");
  }
  if (input.profile === "react-web" && input.defects) packages.add(sentryCliDependency.name);
  if (input.profile !== "library") packages.add("effect");
  return [...packages]
    .toSorted()
    .map((name) =>
      name === sentryCliDependency.name ? sentryCliDependency : { name, installSpec: name },
    );
};

const contractSource = (
  serviceName: string,
): string => `import { Contract, defineTelemetryContract } from "@equipe-tech/observability";
import { Effect } from "effect";

export const telemetryContractDefinition = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    ApplicationOperation: {
      name: "application.operation",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {},
  auditActions: {},
});

export const telemetryContract = await Effect.runPromise(
  defineTelemetryContract(telemetryContractDefinition),
);
export const telemetryServiceName = ${JSON.stringify(serviceName)};
`;

const contractIndexDocument = (serviceName: string): string =>
  json({
    index: 1,
    contractVersion: 1,
    service: serviceName,
    events: [
      {
        name: "application.operation",
        kind: "operation",
        attributes: [],
        attributeClassifications: [],
      },
    ],
    metrics: [],
    aliases: [],
  });

const contractIndexSource = (): string => `import { Contract } from "@equipe-tech/observability";
import { telemetryContract, telemetryServiceName } from "./contract.ts";

const output = process.argv[2] ?? new URL("contract.json", import.meta.url).pathname;
await Bun.write(output, JSON.stringify(Contract.contractIndex(telemetryContract, telemetryServiceName), undefined, 2) + "\\n");
`;

const policySource =
  (): string => `import type { DataPolicyInput } from "@equipe-tech/observability/policy";

export const observabilityPolicy = {
  attributes: {},
  blockedKeys: [],
  blockedValuePatterns: [],
} satisfies DataPolicyInput;
`;

const nodeBootstrap = (input: SetupInput): string => {
  const sentryImport = input.defects
    ? `import { sentryDefectAdapter } from "@equipe-tech/observability-sentry/node";\n`
    : "";
  const sentryRegistration = input.defects ? ", sentryDefectAdapter().registration" : "";
  return `import { createNodeObservability } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
${sentryImport}import { telemetryContract } from "../../observability/contract.ts";
import { observabilityPolicy } from "../../observability/policy.ts";

export const startObservability = (env: { readonly [name: string]: string | undefined }) =>
  createNodeObservability({
    profile: ${JSON.stringify(input.profile)},
    env,
    contract: telemetryContract,
    policy: observabilityPolicy,
    adapters: [evlogAdapter().registration${sentryRegistration}],
  });
`;
};

const nestBootstrap = (input: SetupInput): string => {
  const sentryImport = input.defects
    ? `import { sentryDefectAdapter } from "@equipe-tech/observability-sentry/node";\n`
    : "";
  const sentryRegistration = input.defects ? ", sentryDefectAdapter().registration" : "";
  const browserImport = input.browserIngest
    ? `import { Module } from "@nestjs/common";\nimport { createBrowserEventsController } from "@equipe-tech/observability-nestjs";\n`
    : "";
  const browserComposition = input.browserIngest
    ? `\nexport const createNestBrowserObservability = async (env: { readonly [name: string]: string | undefined }) => {
  const handle = await startNestObservability(env);
  if (!handle.enabled) throw new Error("Nest browser ingest requires enabled observability.");
  const BrowserEventsController = createBrowserEventsController(handle.runtime, {
    eventLayer: handle.eventLayer,
    path: ${JSON.stringify(input.ingestPath)},
  });
  class ApplicationObservabilityModule {}
  Module({ controllers: [BrowserEventsController] })(ApplicationObservabilityModule);
  return { handle, module: ApplicationObservabilityModule };
};
`
    : "";
  return `${browserImport}import { createNodeObservability } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
${sentryImport}import { telemetryContract } from "../../observability/contract.ts";
import { observabilityPolicy } from "../../observability/policy.ts";

export const startNestObservability = (env: { readonly [name: string]: string | undefined }) =>
  createNodeObservability({
    profile: "nestjs-api",
    env,
    contract: telemetryContract,
    policy: observabilityPolicy,
    adapters: [evlogAdapter().registration${sentryRegistration}],
  });
${browserComposition}`;
};

const reactBootstrap = (
  input: SetupInput,
): string => `import { createBrowserObservability } from "@equipe-tech/observability-react";
import { observabilityPolicy } from "../../observability/policy.ts";

export type BrowserObservabilityValues = {
  readonly serviceVersion: string;
  readonly environment: string;
  readonly ingestEndpoint: string;
  readonly sentryDsn?: string;
};

export const startBrowserObservability = (values: BrowserObservabilityValues) =>
  createBrowserObservability({
    service: { name: ${JSON.stringify(input.serviceName)}, version: values.serviceVersion, environment: values.environment },
    policy: observabilityPolicy,
    events: { endpoint: values.ingestEndpoint },
    metrics: ${input.metrics},
    sentry: values.sentryDsn === undefined ? { disabled: true } : { dsn: values.sentryDsn },
  });
`;

const conformanceEvidenceSource =
  (): string => `import type { ConformanceEvidenceProvider } from "@equipe-tech/observability/testing";

export const applicationEvidenceProviders = async (): Promise<ReadonlyArray<ConformanceEvidenceProvider>> => [];
`;

const conformanceTargetSource = (input: SetupInput): string => {
  const serviceName = input.serviceName ?? "library";
  const environment = input.environments[0] ?? "test";
  const traces = input.profile !== "library" && input.profile !== "cli";
  const staticOperations =
    input.profile === "library"
      ? ""
      : `import { OperationsContractIndex, parseOperationsManifest } from "@equipe-tech/observability-cli";\nimport { operationsManifestConformance } from "@equipe-tech/observability-cli/testing";\n`;
  const operationsProviders =
    input.profile === "library"
      ? ""
      : `\n  const contractIndex = Schema.decodeUnknownSync(OperationsContractIndex)(JSON.parse(await Bun.file(new URL("contract.json", import.meta.url)).text()));
  const manifest = await Effect.runPromise(parseOperationsManifest(await Bun.file(new URL("operations.yaml", import.meta.url)).text()));
  providers.push(...operationsManifestConformance({ manifest, contract: contractIndex }));\n`;
  const lifecycle =
    input.profile === "library" ? "libraryLifecycleConformance({ runtimeMarkers: [] })," : "";
  return `import { Effect, Schema } from "effect";
${staticOperations}import { packageBoundaryConformance } from "@equipe-tech/observability-cli/testing";
import {
  conformanceTargetBinding,
  contractConformance,
  identityConformance,
  libraryLifecycleConformance,
  policyConformance,
  profileConformance,
  type ConformanceEvidenceProvider,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { telemetryContract, telemetryContractDefinition } from "./contract.ts";
import { applicationEvidenceProviders } from "./conformance.evidence.ts";
import { observabilityPolicy } from "./policy.ts";

export const applicationConformanceTarget = async (): Promise<ConformanceTarget> => {
  const serviceVersion = process.env[${JSON.stringify(input.releaseVariable)}];
  if (serviceVersion === undefined) throw new Error(${JSON.stringify(`${input.releaseVariable} is required for conformance identity.`)});
  const identity = { serviceName: ${JSON.stringify(serviceName)}, serviceVersion, environment: ${JSON.stringify(environment)} };
  const providers: Array<ConformanceEvidenceProvider> = [
    profileConformance({ profile: ${JSON.stringify(input.profile)}, service: { name: identity.serviceName, version: identity.serviceVersion, environment: identity.environment } }),
    ${input.profile === "library" ? "" : "identityConformance({ identity }),"}
    contractConformance({ contract: telemetryContractDefinition }),
    policyConformance({ policy: observabilityPolicy }),
    ${lifecycle}
    packageBoundaryConformance({ projectRoot: process.cwd(), sourceRoots: ${input.profile === "library" ? '["observability"]' : '["src", "observability"]'} }),
  ];${operationsProviders}
  providers.push(...(await applicationEvidenceProviders()));
  return {
    name: identity.serviceName,
    profile: ${JSON.stringify(input.profile)},
    environment: identity.environment,
    topology: "local",
    capabilities: { traces: ${traces}, metrics: ${input.metrics}, defects: ${input.defects}, browserIngest: ${input.browserIngest}, audit: false },
    binding: conformanceTargetBinding(telemetryContract, identity),
    providers,
  };
};
`;
};

const conformanceSource = (): string => `import { Effect } from "effect";
import { assertConforms, runConformance } from "@equipe-tech/observability/testing";
import { applicationConformanceTarget } from "./conformance.target.ts";

const target = await applicationConformanceTarget();
const report = await Effect.runPromise(runConformance(target));
process.stdout.write(JSON.stringify(report) + "\\n");
await Effect.runPromise(assertConforms(report));
`;

const browserCanarySource =
  (): string => `import { runBrowserDeliveryCanary } from "@equipe-tech/observability-react";

const endpoint = process.env.OBSERVABILITY_BROWSER_CANARY_ENDPOINT;
if (endpoint === undefined) throw new Error("OBSERVABILITY_BROWSER_CANARY_ENDPOINT is required.");
const receipt = await runBrowserDeliveryCanary({ endpoint: new URL(endpoint), topology: "published" });
process.stdout.write(JSON.stringify(receipt) + "\\n");
`;

const nodeCanarySource = (): string => `import { Effect } from "effect";
import { ApplicationCanary } from "@equipe-tech/observability-cli";

await Effect.runPromise(
  Effect.flatMap(ApplicationCanary, (canary) => canary.run).pipe(
    Effect.provide(ApplicationCanary.layer),
  ),
);
`;

const sourceMapSource = (input: SetupInput): string => `import { Effect } from "effect";
import { sentrySourceMapUpload } from "@equipe-tech/observability-sentry";
import { executeSentrySourceMapUpload, sentryCliSourceMapTransport } from "@equipe-tech/observability-sentry/release";

const release = process.env[${JSON.stringify(input.releaseVariable)}];
if (release === undefined) throw new Error(${JSON.stringify(`${input.releaseVariable} is required.`)});
const plan = sentrySourceMapUpload({
  organization: ${JSON.stringify(input.sentryOrganization)},
  project: ${JSON.stringify(input.sentryProject)},
  release,
  includePaths: ${JSON.stringify(input.sourceMapBuild?.includePaths ?? ["dist"])},
});
const transport = sentryCliSourceMapTransport({ executable: "./node_modules/.bin/sentry-cli" });
const receipt = await Effect.runPromise(executeSentrySourceMapUpload(plan, transport));
process.stdout.write(JSON.stringify(receipt) + "\\n");
`;

const sentryTransportSource = (): string => `import { Effect } from "effect";
import { SentryReleaseError, type SentryReleaseTransport } from "@equipe-tech/observability-sentry/release";

export const applicationSentryReleaseTransport: SentryReleaseTransport = {
  acquire: Effect.fail(new SentryReleaseError({
    code: "OBS_SENTRY_RELEASE_VERIFICATION_FAILED",
    message: "Bind the application Sentry verification event and read-back transport before release.",
    cause: "application Sentry release transport is not bound",
  })),
  release: () => Effect.void,
};
`;

const sentryCanarySource = (input: SetupInput): string => `import { Effect } from "effect";
import { runSentryReleaseVerification } from "@equipe-tech/observability-sentry/release";
import { applicationSentryReleaseTransport } from "./sentry.transport.ts";

const serviceVersion = process.env[${JSON.stringify(input.releaseVariable)}];
const environment = process.env.OTEL_DEPLOYMENT_ENVIRONMENT;
if (serviceVersion === undefined) throw new Error(${JSON.stringify(`${input.releaseVariable} is required.`)});
if (environment === undefined) throw new Error("OTEL_DEPLOYMENT_ENVIRONMENT is required.");
const receipt = await Effect.runPromise(runSentryReleaseVerification({
  serviceName: ${JSON.stringify(input.serviceName)},
  serviceVersion,
  environment,
}, applicationSentryReleaseTransport));
process.stdout.write(JSON.stringify(receipt) + "\\n");
`;

const workflowSource = (input: SetupInput): string => {
  const sentryLogin = input.defects
    ? `      - name: Prepare Sentry credentials
        env:
          SENTRY_AUTH_TOKEN: \${{ secrets.SENTRY_AUTH_TOKEN }}
        run: bun ./node_modules/@equipe-tech/observability-cli/dist/main.js auth login sentry --organization ${input.sentryOrganization} --team ${input.sentryTeam} --token-env SENTRY_AUTH_TOKEN
`
    : "";
  const sourceMapSteps =
    input.profile === "react-web" && input.defects && input.sourceMapBuild !== undefined
      ? `      - name: Require fresh source-map output
        run: |
          for path in ${input.sourceMapBuild.includePaths.join(" ")}; do
            ancestor="$path"
            while test "$ancestor" != .; do
              if test -L "$ancestor" || { test "$ancestor" != "$path" && test -e "$ancestor" && ! test -d "$ancestor"; }; then
                printf '%s\\n' 'Blocked source-map prerequisite. Declared paths must not cross linked or non-directory ancestors.' >&2
                exit 1
              fi
              ancestor="$(dirname "$ancestor")"
            done
            if test -e "$path" || test -L "$path"; then
              printf '%s\\n' "Blocked source-map prerequisite: $path must not exist before the build." >&2
              exit 1
            fi
          done
      - name: Build application source maps
        run: bun run ${input.sourceMapBuild.script}
      - name: Verify local release prerequisites
        run: bun ./node_modules/@equipe-tech/observability-cli/dist/main.js setup verify-release --dir .
      - name: Upload source maps
        env:
          SENTRY_AUTH_TOKEN: \${{ secrets.SENTRY_AUTH_TOKEN }}
        run: bun observability/source-maps.ts
`
      : "";
  const browser = input.browserIngest
    ? `      - name: Verify published browser route
        env:
          OBSERVABILITY_BROWSER_CANARY_ENDPOINT: \${{ secrets.OBSERVABILITY_BROWSER_CANARY_ENDPOINT }}
        run: bun observability/browser-canary.ts
`
    : "";
  const sentry = input.defects
    ? "      - name: Verify Sentry event and read-back\n        run: bun observability/sentry-canary.ts\n"
    : "";
  return `name: observability
on:
  pull_request:
  push:
    tags:
      - "v*"
permissions:
  contents: read
jobs:
  verify-local:
    runs-on: ubuntu-latest
    env:
      ${input.releaseVariable}: \${{ github.sha }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun ./node_modules/@equipe-tech/observability-cli/dist/main.js setup verify --dir . --target local --reconcile --conform
  verify-providers:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: verify-local
    runs-on: ubuntu-latest
    env:
      OBSERVABILITY_HOME: \${{ runner.temp }}/observability-provider-state
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Prepare Axiom credentials
        env:
          OBSERVABILITY_AXIOM_AUTH_TOKEN: \${{ secrets.OBSERVABILITY_AXIOM_AUTH_TOKEN }}
        run: bun ./node_modules/@equipe-tech/observability-cli/dist/main.js auth login axiom --organization-id ${input.axiomOrganizationId} --token-env OBSERVABILITY_AXIOM_AUTH_TOKEN
${sentryLogin}      - name: Verify provider resources
        run: bun ./node_modules/@equipe-tech/observability-cli/dist/main.js setup verify --dir . --target deployed --environment ${input.environments[0]} --provider-read
      - name: Remove credential state
        if: always()
        run: rm -rf -- "$OBSERVABILITY_HOME"
  release-canary:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    needs: [verify-local, verify-providers]
    env:
      ${input.releaseVariable}: \${{ github.ref_name }}
      OTEL_DEPLOYMENT_ENVIRONMENT: ${input.environments[0]}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
${sourceMapSteps}      - name: Run application canary
        env:
          OBSERVABILITY_APPLICATION_CANARY_COMMAND: \${{ secrets.OBSERVABILITY_APPLICATION_CANARY_COMMAND }}
        run: bun observability/canary.ts
${browser}${sentry}`;
};

const operationsYaml = (input: SetupInput): string => `version: 1
contractVersion: 1
service: ${input.serviceName}
environments:
${input.environments.map((environment) => `  - ${environment}`).join("\n")}
retention:
${input.environments.map((environment) => `  - environment: ${environment}\n    days: 30`).join("\n")}
dashboards: []
monitors: []
sentry:
  enabled: ${input.defects}
`;

type RenderedSetupFile = Omit<SetupPlannedFile, "action" | "recorded">;

const renderedFiles = (
  input: SetupInput,
  dependencies: ReadonlyArray<SetupDependency>,
): ReadonlyArray<RenderedSetupFile> => {
  const packages = dependencies.map((dependency) => dependency.name);
  const serviceName = input.serviceName ?? "library";
  const files: Array<RenderedSetupFile> = [
    {
      path: "observability/contract.ts",
      content: contractSource(serviceName),
      ownership: "user-preserved",
    },
    {
      path: "observability/contract-index.ts",
      content: contractIndexSource(),
      ownership: "user-preserved",
    },
    {
      path: "observability/contract.json",
      content: contractIndexDocument(serviceName),
      ownership: "skill-owned",
    },
    { path: "observability/policy.ts", content: policySource(), ownership: "user-preserved" },
    {
      path: "observability/conformance.evidence.ts",
      content: conformanceEvidenceSource(),
      ownership: "user-preserved",
    },
    {
      path: "observability/conformance.target.ts",
      content: conformanceTargetSource(input),
      ownership: "user-preserved",
    },
    {
      path: "observability/conformance.ts",
      content: conformanceSource(),
      ownership: "skill-owned",
    },
    {
      path: "observability/dependencies.json",
      content: json({ packages, dependencies }),
      ownership: "skill-owned",
    },
  ];
  if (input.profile === "library") return files;
  files.push(
    {
      path: "observability/operations.yaml",
      content: operationsYaml(input),
      ownership: "user-preserved",
    },
    {
      path: "observability/topology.json",
      content: json({
        publicOrigin: optional(input.publicOrigin?.origin),
        proxyPolicy: input.proxyPolicy,
        ingestionPath: input.ingestPath,
        platformRulesDeclaration: "observability/platform-rules.json",
        networkPolicyDeclaration: "observability/network-policy.json",
      }),
      ownership: "user-preserved",
    },
    {
      path: "observability/environment.json",
      content: json({
        environments: input.environments,
        otlpEndpoint: optional(input.otlpEndpoint?.href),
        variables: {
          serviceVersion: input.releaseVariable,
          sentryDsn: input.sentryDsnVariable,
          otlpEndpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
        },
      }),
      ownership: "user-preserved",
    },
    {
      path: "observability/platform-rules.json",
      content: json({ version: 1, rules: [], extensions: [] }),
      ownership: "user-preserved",
    },
    {
      path: "observability/network-policy.json",
      content: json({ version: 1, ingress: [], egress: [], extensions: [] }),
      ownership: "user-preserved",
    },
    {
      path: "src/observability/bootstrap.ts",
      content:
        input.profile === "nestjs-api"
          ? nestBootstrap(input)
          : input.profile === "react-web"
            ? reactBootstrap(input)
            : nodeBootstrap(input),
      ownership: "user-preserved",
    },
    {
      path: "observability/canary.ts",
      content: nodeCanarySource(),
      ownership: "skill-owned",
    },
    {
      path: ".github/workflows/observability.yml",
      content: workflowSource(input),
      ownership: "skill-owned",
    },
  );
  if (input.browserIngest)
    files.push({
      path: "observability/browser-canary.ts",
      content: browserCanarySource(),
      ownership: "skill-owned",
    });
  if (input.defects)
    files.push(
      {
        path: "observability/sentry.transport.ts",
        content: sentryTransportSource(),
        ownership: "user-preserved",
      },
      {
        path: "observability/sentry-canary.ts",
        content: sentryCanarySource(input),
        ownership: "skill-owned",
      },
    );
  if (input.profile === "react-web" && input.defects)
    files.push({
      path: "observability/source-maps.ts",
      content: sourceMapSource(input),
      ownership: "skill-owned",
    });
  return files;
};

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
};

const readRecord = async (directory: string): Promise<DecisionRecord | undefined> => {
  const content = await readText(join(directory, "observability/setup.json"));
  if (content === undefined) return undefined;
  return decodeDecisionRecord(JSON.parse(content));
};

const decisionInput = (record: DecisionRecord): SetupInput => {
  if (record.version === 2) return record.input;
  return {
    profile: record.input.profile,
    serviceName: record.input.serviceName,
    environments: record.input.environments,
    otlpEndpoint: record.input.otlpEndpoint,
    publicOrigin: record.input.publicOrigin,
    ingestPath: record.input.ingestPath,
    proxyPolicy: record.input.proxyPolicy,
    sentryDsnVariable: record.input.sentryDsnVariable,
    releaseVariable: record.input.releaseVariable,
    axiomOrganizationId: undefined,
    sentryOrganization: record.input.sentryOrganization,
    sentryTeam: undefined,
    sentryProject: record.input.sentryProject,
    sourceMapBuild: undefined,
    browserIngest: record.input.browserIngest,
    defects: record.input.defects,
    metrics: record.input.metrics,
  };
};

const officialProfiles = new Set<string>(Object.keys(observabilityProfiles));

const validateInput = Effect.fn("validateSetupInput")(function* (encoded: SetupInputEncoded) {
  if (ForbiddenSecret.test(JSON.stringify(encoded)))
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "Setup does not accept credential or token values. Supply variable names only.",
      "credential-bearing input",
    );
  if (!officialProfiles.has(encoded.profile)) {
    return yield* fail(
      "OBS_SETUP_PROFILE_INVALID",
      `Profile ${encoded.profile} is not official. Select nestjs-api, worker, react-web, cli, or library.`,
      encoded.profile,
    );
  }
  const sourceMapDeclarationMissing =
    encoded.sourceMapBuildScript === undefined && encoded.sourceMapPaths.length === 0;
  const sourceMapDeclarationPartial =
    encoded.sourceMapBuildScript === undefined || encoded.sourceMapPaths.length === 0;
  if (!sourceMapDeclarationMissing && sourceMapDeclarationPartial)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--source-map-build-script and at least one --source-map-path must be provided together.",
      "source-map-build",
    );
  const input = yield* decodeSetupInput({
    profile: encoded.profile,
    serviceName: encoded.serviceName,
    environments: encoded.environments,
    otlpEndpoint: encoded.otlpEndpoint,
    publicOrigin: encoded.publicOrigin,
    ingestPath: encoded.ingestPath,
    proxyPolicy: encoded.proxyPolicy,
    sentryDsnVariable: encoded.sentryDsnVariable,
    releaseVariable: encoded.releaseVariable,
    axiomOrganizationId: encoded.axiomOrganizationId,
    sentryOrganization: encoded.sentryOrganization,
    sentryTeam: encoded.sentryTeam,
    sentryProject: encoded.sentryProject,
    sourceMapBuild: sourceMapDeclarationMissing
      ? undefined
      : { script: encoded.sourceMapBuildScript, includePaths: encoded.sourceMapPaths },
    browserIngest: encoded.browserIngest,
    defects: encoded.defects,
    metrics: encoded.metrics,
  }).pipe(
    Effect.mapError((cause) =>
      fail(
        "OBS_SETUP_INPUT_INVALID",
        "The setup inputs are invalid. Supply valid application-owned identity, topology, variable names, and profile selections.",
        cause,
      ),
    ),
  );
  const profile = observabilityProfiles[input.profile];
  const requiredService = input.profile !== "library";
  if (requiredService && input.serviceName === undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--service-name is required for executable profiles.",
      "service-name",
    );
  if (input.profile === "library" && input.serviceName !== undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "The library profile does not accept --service-name because it installs no runtime.",
      "service-name",
    );
  if (input.profile !== "library" && input.environments.length === 0)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "At least one --environment is required for executable profiles.",
      "environment",
    );
  if (profile.browserIngest === "forbidden" && input.browserIngest)
    return yield* fail(
      "OBS_SETUP_PROFILE_INVALID",
      `${input.profile} forbids browser ingest.`,
      "browser-ingest",
    );
  if (profile.browserIngest === "required" && !input.browserIngest)
    return yield* fail(
      "OBS_SETUP_PROFILE_INVALID",
      `${input.profile} requires browser ingest.`,
      "browser-ingest",
    );
  if (profile.metrics === "forbidden" && input.metrics)
    return yield* fail("OBS_SETUP_PROFILE_INVALID", `${input.profile} forbids metrics.`, "metrics");
  if (profile.defects === "forbidden" && input.defects)
    return yield* fail("OBS_SETUP_PROFILE_INVALID", `${input.profile} forbids defects.`, "defects");
  if (
    input.environments.includes("production") &&
    profile.defects === "required-in-production" &&
    !input.defects
  )
    return yield* fail(
      "OBS_SETUP_PROFILE_INVALID",
      `${input.profile} requires defects in production.`,
      "defects",
    );
  if (
    (input.profile === "worker" || input.profile === "nestjs-api" || input.profile === "cli") &&
    input.otlpEndpoint === undefined
  )
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--otlp-endpoint is required for Node profiles.",
      "otlp-endpoint",
    );
  if (
    input.otlpEndpoint !== undefined &&
    (input.otlpEndpoint.username.length > 0 ||
      input.otlpEndpoint.password.length > 0 ||
      input.otlpEndpoint.search.length > 0 ||
      input.otlpEndpoint.hash.length > 0)
  )
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "The OTLP endpoint must not contain credentials, query parameters, or fragments.",
      "otlp-endpoint",
    );
  if (input.browserIngest && input.publicOrigin === undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--public-origin is required when browser ingest is selected.",
      "public-origin",
    );
  if (
    input.publicOrigin !== undefined &&
    (input.publicOrigin.protocol !== "https:" ||
      input.publicOrigin.username.length > 0 ||
      input.publicOrigin.password.length > 0 ||
      input.publicOrigin.search.length > 0 ||
      input.publicOrigin.hash.length > 0)
  )
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "The published browser origin must use HTTPS without credentials, query parameters, or fragments.",
      "public-origin",
    );
  if (["SENTRY_RELEASE", "OTEL_SERVICE_RELEASE"].includes(input.releaseVariable))
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "Use OTEL_SERVICE_VERSION as the canonical release variable.",
      "release-variable",
    );
  if (input.profile !== "library" && input.axiomOrganizationId === undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--axiom-organization-id is required for executable release verification.",
      "axiom-organization-id",
    );
  if (input.defects && (input.sentryOrganization === undefined || input.sentryTeam === undefined))
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--sentry-org and --sentry-team are required when defects are selected.",
      "sentry-authentication",
    );
  if (
    input.profile === "react-web" &&
    input.defects &&
    (input.sentryProject === undefined || input.sourceMapBuild === undefined)
  )
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--sentry-project, --source-map-build-script, and --source-map-path are required for React source maps.",
      "sentry-source-maps",
    );
  if (
    !(input.profile === "react-web" && input.defects) &&
    (input.sourceMapBuild !== undefined || input.sentryProject !== undefined)
  )
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "Source-map declarations apply only to the React profile with defects enabled.",
      "sentry-source-maps",
    );
  return input;
});

const classify = async (
  directory: string,
  rendered: ReadonlyArray<RenderedSetupFile>,
  record: DecisionRecord | undefined,
): Promise<ReadonlyArray<SetupPlannedFile>> => {
  const recorded = new Map(record?.files.map((file) => [file.path, file]));
  const files: Array<SetupPlannedFile> = [];
  for (const file of rendered) {
    const current = await readText(join(directory, file.path));
    if (current === undefined) files.push({ ...file, action: "create", recorded: false });
    else if (current === file.content)
      files.push({ ...file, action: "unchanged", recorded: recorded.has(file.path) });
    else if (
      recorded.get(file.path)?.digest === digest(current) &&
      recorded.get(file.path)?.ownership === "skill-owned" &&
      file.ownership === "skill-owned"
    )
      files.push({ ...file, action: "updated", recorded: true });
    else if (
      record?.version === 1 &&
      file.path === "observability/canary.ts" &&
      recorded.has(file.path)
    )
      files.push({ ...file, ownership: "user-preserved", action: "preserved", recorded: true });
    else if (
      (file.ownership === "user-preserved" ||
        recorded.get(file.path)?.ownership === "user-preserved") &&
      recorded.has(file.path)
    )
      files.push({ ...file, ownership: "user-preserved", action: "preserved", recorded: true });
    else files.push({ ...file, action: "conflict", recorded: recorded.has(file.path) });
  }
  return files;
};

const installationFiles = ["package.json", "bun.lock", "bun.lockb"];
const installationDirectories = ["node_modules"];
const ApplicationPackageManifest = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
});
const decodeApplicationPackageManifest = Schema.decodeUnknownPromise(ApplicationPackageManifest, {
  onExcessProperty: "ignore",
});

const validateApplicationBuildScript = Effect.fn("validateApplicationBuildScript")(function* (
  directory: string,
  input: SetupInput,
) {
  if (!(input.profile === "react-web" && input.defects) || input.sourceMapBuild === undefined)
    return;
  yield* checkSetupPaths(directory, ["package.json"]);
  const manifest = yield* Effect.tryPromise({
    try: async () => {
      const content = await readText(join(directory, "package.json"));
      if (content === undefined)
        throw fail(
          "OBS_SETUP_INPUT_MISSING",
          "A readable application package.json with the declared source-map build script is required.",
          "missing package manifest",
        );
      return decodeApplicationPackageManifest(JSON.parse(content));
    },
    catch: (cause) =>
      fail(
        "OBS_SETUP_INPUT_MISSING",
        "A readable application package.json with the declared source-map build script is required.",
        cause,
      ),
  });
  if (!Object.hasOwn(manifest.scripts, input.sourceMapBuild.script))
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      `The application package.json does not declare script ${input.sourceMapBuild.script}. Add it before retrying setup.`,
      "source-map-build-script",
    );
});

const planSetup = Effect.fn("planSetup")(function* (
  directory: string,
  encoded: SetupInputEncoded,
  installDependencies = false,
) {
  const input = yield* validateInput(encoded);
  const target = yield* resolveSetupTarget(directory);
  yield* validateApplicationBuildScript(target.directory, input);
  const dependencies = dependenciesFor(input);
  const packages = dependencies.map((dependency) => dependency.name);
  const rendered = renderedFiles(input, dependencies);
  yield* checkSetupPaths(
    target.directory,
    rendered.map((file) => file.path),
  );
  if (installDependencies)
    yield* checkSetupPaths(target.directory, installationFiles, installationDirectories);
  const files = yield* Effect.tryPromise({
    try: () =>
      readRecord(target.directory).then((record) => classify(target.directory, rendered, record)),
    catch: (cause) =>
      fail("OBS_SETUP_INPUT_INVALID", "The existing setup decision record is unreadable.", cause),
  });
  return { ...target, input, packages, dependencies, files } satisfies SetupPlan;
});

const assertAllowed = (plan: SetupPlan): void => {
  const forbidden =
    /from ["'](?:@opentelemetry\/|evlog(?:\/|["'])|@sentry\/|effect\/unstable\/)|\b(?:receivers|exporters|processors):|sntrys_|https:\/\/[^\s"']+@/;
  const violation = plan.files.find((file) => forbidden.test(file.content));
  if (violation !== undefined)
    throw fail(
      "OBS_SETUP_FORBIDDEN_OUTPUT",
      `Generated file ${violation.path} crosses a platform-owner boundary.`,
      violation.path,
    );
};

const assertNoSymlinkTraversal = async (
  root: string,
  paths: ReadonlyArray<string>,
  directories: ReadonlyArray<string> = [],
): Promise<void> => {
  const candidates = new Map<string, "file" | "directory">([[root, "directory"]]);
  for (const path of [...paths, ...directories]) {
    const destination = resolve(root, path);
    const rooted = relative(root, destination);
    if (isAbsolute(path) || rooted === "" || rooted === ".." || rooted.startsWith(`..${sep}`))
      throw fail(
        "OBS_SETUP_CONFLICT",
        "Setup requires output paths inside the target directory. Correct the setup paths before retrying.",
        path,
      );
    candidates.set(destination, directories.includes(path) ? "directory" : "file");
  }
  for (const destination of candidates.keys()) {
    let current = dirname(destination);
    while (true) {
      candidates.set(current, "directory");
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const [candidate, kind] of [...candidates].sort(
    ([left], [right]) => left.length - right.length,
  )) {
    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || (kind === "file" && entry.nlink > 1))
        throw fail(
          "OBS_SETUP_CONFLICT",
          "Setup refuses linked target ancestors or output files. Use an unlinked directory and regular files before retrying.",
          candidate,
        );
      if (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
        throw fail(
          "OBS_SETUP_CONFLICT",
          "Setup requires directory ancestors and regular output files. Correct the filesystem entries before retrying.",
          candidate,
        );
    } catch (cause) {
      if (cause instanceof SetupError) throw cause;
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
  }
};

const checkSetupPaths = (
  root: string,
  paths: ReadonlyArray<string>,
  directories: ReadonlyArray<string> = [],
): Effect.Effect<void, SetupError> =>
  Effect.tryPromise({
    try: () => assertNoSymlinkTraversal(root, [...paths, "observability/setup.json"], directories),
    catch: (cause) =>
      cause instanceof SetupError
        ? cause
        : fail(
            "OBS_SETUP_CONFLICT",
            "Setup could not inspect the target paths. Review filesystem permissions before retrying.",
            cause,
          ),
  });

const resolveSetupTarget = (directory: string): Effect.Effect<SetupTarget, SetupError> =>
  Effect.tryPromise({
    try: async () => {
      const requestedDirectory = resolve(directory);
      let canonicalDirectory = requestedDirectory;
      if (process.platform === "darwin") {
        for (const prefix of ["/tmp", "/var", "/etc"]) {
          if (requestedDirectory !== prefix && !requestedDirectory.startsWith(`${prefix}/`))
            continue;
          if (
            (await lstat(prefix)).isSymbolicLink() &&
            (await readlink(prefix)) === `private${prefix}`
          )
            canonicalDirectory = `/private${requestedDirectory}`;
        }
      }
      await assertNoSymlinkTraversal(canonicalDirectory, []);
      return { requestedDirectory, directory: canonicalDirectory };
    },
    catch: (cause) =>
      cause instanceof SetupError
        ? cause
        : fail(
            "OBS_SETUP_CONFLICT",
            "Setup could not resolve a safe target directory. Use an unlinked canonical path before retrying.",
            cause,
          ),
  });

const atomicWrite = async (root: string, relativePath: string, content: string): Promise<void> => {
  await assertNoSymlinkTraversal(root, [relativePath]);
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlinkTraversal(root, [relativePath]);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await assertNoSymlinkTraversal(root, [relativePath]);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const writeSetup = Effect.fn("writeSetup")(function* (
  directory: string,
  encoded: SetupInputEncoded,
  force: boolean,
  installDependencies = false,
) {
  const plan = yield* planSetup(directory, encoded, installDependencies);
  yield* Effect.try({
    try: () => assertAllowed(plan),
    catch: (cause) =>
      cause instanceof SetupError
        ? cause
        : fail(
            "OBS_SETUP_FORBIDDEN_OUTPUT",
            "Generated output failed the owner boundary scan.",
            cause,
          ),
  });
  const conflicts = plan.files.filter(
    (file) =>
      file.action === "conflict" && !(force && file.ownership === "skill-owned" && file.recorded),
  );
  if (conflicts.length > 0)
    return yield* fail(
      "OBS_SETUP_CONFLICT",
      `Setup found conflicting files: ${conflicts.map((file) => file.path).join(", ")}. No files were written.`,
      conflicts.map((file) => file.path),
    );
  const writable = plan.files.filter(
    (file) =>
      file.action === "create" ||
      file.action === "updated" ||
      (force && file.action === "conflict" && file.ownership === "skill-owned" && file.recorded),
  );
  yield* Effect.tryPromise({
    try: async () => {
      const outputPaths = [...plan.files.map((file) => file.path), "observability/setup.json"];
      await assertNoSymlinkTraversal(plan.directory, outputPaths);
      const finalFiles: Array<{
        readonly path: string;
        readonly ownership: SetupFileOwnership;
        readonly digest: string;
      }> = [];
      for (const file of plan.files) {
        const content =
          file.action === "preserved"
            ? await readFile(join(plan.directory, file.path), "utf8")
            : file.content;
        finalFiles.push({ path: file.path, ownership: file.ownership, digest: digest(content) });
      }
      const record = json({
        version: 2,
        target: { requestedDirectory: plan.requestedDirectory, directory: plan.directory },
        profile: plan.input.profile,
        input: plan.input,
        packages: [...plan.packages],
        dependencies: [...plan.dependencies],
        files: finalFiles,
      });
      if (ForbiddenSecret.test(record))
        throw fail(
          "OBS_SETUP_FORBIDDEN_OUTPUT",
          "The setup decision record contains a credential-bearing value.",
          "observability/setup.json",
        );
      for (const file of writable) {
        await atomicWrite(plan.directory, file.path, file.content);
      }
      await atomicWrite(plan.directory, "observability/setup.json", record);
    },
    catch: (cause) =>
      cause instanceof SetupError
        ? cause
        : fail(
            "OBS_SETUP_CONFLICT",
            "Setup could not write the complete application composition. Review filesystem permissions and retry.",
            cause,
          ),
  });
  return {
    ...plan,
    files: plan.files.map((file): SetupPlannedFile => {
      if (
        force &&
        file.action === "conflict" &&
        file.ownership === "skill-owned" &&
        file.recorded
      ) {
        return { ...file, action: "updated" };
      }
      return file;
    }),
  };
});

const commandOutput = (stdout: string, stderr: string, exitCode: number): string => {
  if (exitCode === 0) return stdout.trim();
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("error:") || line.startsWith("code:"))
    .slice(0, 4)
    .join(" ");
};

const runCommand = (
  command: ReadonlyArray<string>,
  cwd: string,
  code: SetupError["code"],
  operation: string,
  paths: ReadonlyArray<string>,
  directories: ReadonlyArray<string> = [],
): Effect.Effect<{ readonly exitCode: number; readonly output: string }, SetupError> =>
  Effect.andThen(
    checkSetupPaths(cwd, paths, directories),
    Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...command], {
            cwd,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
          }),
        catch: (cause) => fail(code, `${operation} could not start.`, cause),
      }),
      (child) =>
        Effect.tryPromise({
          try: async () => {
            const [exitCode, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            return { exitCode, output: commandOutput(stdout, stderr, exitCode) };
          },
          catch: (cause) => fail(code, `${operation} could not complete.`, cause),
        }).pipe(
          Effect.timeout("5 minutes"),
          Effect.mapError((cause) =>
            cause instanceof SetupError ? cause : fail(code, `${operation} timed out.`, cause),
          ),
        ),
      (child) =>
        Effect.sync(() => {
          if (process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill();
            }
          } else child.kill();
        }),
    ),
  );

const installSetup = Effect.fn("installSetup")(function* (plan: SetupPlan) {
  const result = yield* runCommand(
    ["bun", "add", "--exact", ...plan.dependencies.map((dependency) => dependency.installSpec)],
    plan.directory,
    "OBS_SETUP_RECONCILE_FAILED",
    "The selected profile dependency installation",
    [...plan.files.map((file) => file.path), ...installationFiles],
    installationDirectories,
  );
  if (result.exitCode !== 0)
    return yield* fail(
      "OBS_SETUP_RECONCILE_FAILED",
      "The selected profile dependencies could not be installed. Restore the application package-manager files or resolve the package error before retrying.",
      result.output,
    );
  return {
    name: "dependencies",
    status: "passed",
    detail: `installed ${plan.dependencies.map((dependency) => dependency.installSpec).join(",")}`,
    exitCode: result.exitCode,
  } satisfies SetupVerificationStep;
});

const verifySetup = Effect.fn("verifySetup")(function* (
  directory: string,
  environment: string | undefined,
  reconcile: boolean,
  conform: boolean,
  providerRead: boolean,
  target: "local" | "deployed" = "local",
) {
  const resolvedTarget = yield* resolveSetupTarget(directory);
  const root = resolvedTarget.directory;
  yield* checkSetupPaths(root, []);
  const record = yield* Effect.tryPromise(() => readRecord(root)).pipe(
    Effect.mapError((cause) =>
      fail("OBS_SETUP_INPUT_INVALID", "The setup decision record is unreadable.", cause),
    ),
  );
  if (record === undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "observability/setup.json is required before verification.",
      "setup.json",
    );
  const input = decisionInput(record);
  const outputPaths = [
    ...renderedFiles(input, dependenciesFor(input)).map((file) => file.path),
    ...record.files.map((file) => file.path),
  ];
  yield* checkSetupPaths(root, outputPaths);
  const steps: Array<SetupVerificationStep> = [];
  const filesystemEffects: Array<string> = [];
  const providerReads: Array<string> = [];
  if (target === "deployed")
    steps.push({
      name: "contract",
      status: "not-applicable",
      detail: "contract reconciliation belongs to the local verification gate",
    });
  else if (reconcile) {
    const result = yield* runCommand(
      [process.execPath, "observability/contract-index.ts"],
      root,
      "OBS_SETUP_RECONCILE_FAILED",
      "Contract reconciliation",
      outputPaths,
    );
    filesystemEffects.push("observability/contract.json");
    steps.push({
      name: "contract",
      status: result.exitCode === 0 ? "passed" : "failed",
      detail: result.output || "contract index regenerated",
      exitCode: result.exitCode,
    });
  } else
    steps.push({
      name: "contract",
      status: "blocked",
      detail: "contract regeneration requires explicit --reconcile",
    });
  const selectedEnvironment = environment ?? input.environments[0];
  if (target === "local")
    steps.push({
      name: "providers",
      status: "not-applicable",
      detail: "provider read-back belongs to the deployed verification gate",
    });
  else if (record.profile === "library")
    steps.push({
      name: "providers",
      status: "not-applicable",
      detail: "library has no provider resources",
    });
  else if (selectedEnvironment === undefined)
    steps.push({ name: "providers", status: "blocked", detail: "no environment was declared" });
  else if (!providerRead)
    steps.push({
      name: "providers",
      status: "blocked",
      detail: `provider read-back for ${selectedEnvironment} requires explicit --provider-read and application credentials`,
    });
  else {
    const executable = fileURLToPath(
      new URL(import.meta.url.endsWith(".ts") ? "../main.ts" : "../main.js", import.meta.url),
    );
    const result = yield* runCommand(
      [
        process.execPath,
        executable,
        "ops",
        "verify",
        "--dir",
        root,
        "--environment",
        selectedEnvironment,
        "--json",
      ],
      root,
      "OBS_SETUP_RECONCILE_FAILED",
      "Provider read-back",
      outputPaths,
    );
    steps.push({
      name: "providers",
      status: result.exitCode === 0 ? "passed" : "failed",
      detail:
        result.output ||
        (result.exitCode === 0
          ? "provider read-back completed"
          : `provider read-back failed with exit code ${result.exitCode}`),
      exitCode: result.exitCode,
    });
    if (result.exitCode === 0) providerReads.push(`ops verify:${selectedEnvironment}`);
  }
  if (target === "deployed")
    steps.push({
      name: "conformance",
      status: "not-applicable",
      detail: "conformance belongs to the local verification gate",
    });
  else if (conform) {
    const result = yield* runCommand(
      [process.execPath, "observability/conformance.ts"],
      root,
      "OBS_SETUP_CONFORMANCE_FAILED",
      "Application conformance",
      outputPaths,
    );
    steps.push({
      name: "conformance",
      status: result.exitCode === 0 ? "passed" : "failed",
      detail: result.output || "conformance completed",
      exitCode: result.exitCode,
    });
  } else
    steps.push({
      name: "conformance",
      status: "blocked",
      detail: "conformance requires explicit --conform",
    });
  steps.push({
    name: "browser-route",
    status: "not-applicable",
    detail: input.browserIngest
      ? target === "deployed"
        ? "the generated published browser canary owns this deployed release gate"
        : "published browser verification belongs to the deployed release gate"
      : "browser ingest is not selected",
  });
  steps.push({
    name: "sentry",
    status: "not-applicable",
    detail: input.defects
      ? target === "deployed"
        ? "the generated Sentry canary owns this deployed release gate"
        : "Sentry verification belongs to the deployed release gate"
      : "defects are not selected",
  });
  const passed = steps.every(
    (step) => step.status === "passed" || step.status === "not-applicable",
  );
  return {
    profile: record.profile,
    ...resolvedTarget,
    filesystemEffects,
    providerReads,
    providerMutations: [],
    steps,
    passed,
  } satisfies SetupVerificationReport;
});

const InstalledSentryCliManifest = Schema.Struct({
  name: Schema.Literal("@sentry/cli"),
  version: Schema.Literal("3.7.0"),
});
const decodeInstalledSentryCliManifest = Schema.decodeUnknownPromise(InstalledSentryCliManifest, {
  onExcessProperty: "ignore",
});
const BasicSourceMap = Schema.Struct({
  version: Schema.Literal(3),
  sources: Schema.NonEmptyArray(Schema.NonEmptyString),
  mappings: Schema.NonEmptyString,
});
const SourceMapOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const IndexedSourceMap = Schema.Struct({
  version: Schema.Literal(3),
  sections: Schema.NonEmptyArray(
    Schema.Struct({
      offset: Schema.Struct({ line: SourceMapOffset, column: SourceMapOffset }),
      map: BasicSourceMap,
    }),
  ),
});
const decodeSourceMap = Schema.decodeUnknownPromise(
  Schema.Union([BasicSourceMap, IndexedSourceMap]),
  {
    onExcessProperty: "ignore",
  },
);

type ReleaseInspection = {
  readonly passed: boolean;
  readonly detail: string;
};

const ReleasePackageManifest = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeReleasePackageManifest = Schema.decodeUnknownPromise(ReleasePackageManifest);

const inspectReleaseDeclaration = async (
  root: string,
  script: string,
): Promise<ReleaseInspection> => {
  try {
    const manifest = await decodeReleasePackageManifest(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    );
    if (!Object.hasOwn(manifest.scripts, script) || !manifest.scripts[script]?.trim())
      return {
        passed: false,
        detail: `application package.json must declare nonempty build script ${script}`,
      };
    const declarations = [
      manifest.dependencies?.[sentryCliDependency.name],
      manifest.devDependencies?.[sentryCliDependency.name],
    ].filter((value) => value !== undefined);
    if (declarations.length === 0 || declarations.some((value) => value !== "3.7.0"))
      return {
        passed: false,
        detail: "application package.json must directly declare exact @sentry/cli@3.7.0",
      };
    return {
      passed: true,
      detail: `build script ${script} and direct exact @sentry/cli@3.7.0 declaration`,
    };
  } catch {
    return {
      passed: false,
      detail: "a readable application package.json with release declarations is required",
    };
  }
};

const inspectUploader = async (root: string): Promise<ReleaseInspection> => {
  try {
    const packageRoot = join(root, "node_modules/@sentry/cli");
    const manifest = await decodeInstalledSentryCliManifest(
      JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
    );
    const executable = join(root, "node_modules/.bin/sentry-cli");
    const executableEntry = await lstat(executable);
    if (!executableEntry.isSymbolicLink() && !executableEntry.isFile())
      return { passed: false, detail: "the application-local sentry-cli executable is not a file" };
    const [resolvedPackage, resolvedExecutable, declaredExecutable] = await Promise.all([
      realpath(packageRoot),
      realpath(executable),
      realpath(join(packageRoot, "bin/sentry-cli")),
    ]);
    const packageRelative = relative(resolvedPackage, resolvedExecutable);
    if (
      packageRelative === "" ||
      packageRelative === ".." ||
      packageRelative.startsWith(`..${sep}`) ||
      resolvedExecutable !== declaredExecutable
    )
      return {
        passed: false,
        detail: "the application-local sentry-cli executable does not resolve to @sentry/cli@3.7.0",
      };
    const executableStat = await stat(resolvedExecutable);
    if (!executableStat.isFile() || executableStat.size === 0)
      return { passed: false, detail: "the application-local sentry-cli executable is empty" };
    await access(resolvedExecutable, constants.X_OK);
    return {
      passed: true,
      detail: `${manifest.name}@${manifest.version} resolves through ./node_modules/.bin/sentry-cli`,
    };
  } catch {
    return {
      passed: false,
      detail: "exact @sentry/cli@3.7.0 and ./node_modules/.bin/sentry-cli are required",
    };
  }
};

const artifactFiles = async (root: string, path: string): Promise<ReadonlyArray<string>> => {
  const target = resolve(root, path);
  const rooted = relative(root, target);
  if (rooted === "" || rooted === ".." || rooted.startsWith(`..${sep}`))
    throw fail(
      "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
      "A declared source-map path escapes the application root. Correct it before retrying.",
      path,
    );
  let ancestor = root;
  for (const segment of rooted.split(sep)) {
    ancestor = join(ancestor, segment);
    const entry = await lstat(ancestor);
    if (
      entry.isSymbolicLink() ||
      (entry.isFile() && entry.nlink > 1) ||
      (ancestor !== target && !entry.isDirectory())
    )
      throw fail(
        "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
        "Declared source-map paths must not cross linked or non-directory boundaries.",
        path,
      );
  }
  const visit = async (current: string): Promise<ReadonlyArray<string>> => {
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1))
      throw fail(
        "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
        "Declared source-map artifacts must not contain linked files or paths.",
        relative(root, current),
      );
    if (entry.isFile()) return [current];
    if (!entry.isDirectory())
      throw fail(
        "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
        "Declared source-map artifacts must be regular files or directories.",
        relative(root, current),
      );
    const children = await readdir(current, { withFileTypes: true });
    const files: Array<string> = [];
    for (const child of children) {
      if (child.isSymbolicLink())
        throw fail(
          "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
          "Declared source-map artifacts must not contain linked entries.",
          relative(root, join(current, child.name)),
        );
      files.push(...(await visit(join(current, child.name))));
    }
    return files;
  };
  return visit(target);
};

const inspectArtifacts = async (
  root: string,
  paths: ReadonlyArray<string>,
): Promise<ReleaseInspection> => {
  try {
    for (const path of paths) {
      const files = await artifactFiles(root, path);
      const nonempty: Array<string> = [];
      for (const file of files) if ((await stat(file)).size > 0) nonempty.push(file);
      const bundles = nonempty.filter((file) => [".js", ".mjs", ".cjs"].includes(extname(file)));
      const maps = nonempty.filter((file) => file.endsWith(".map"));
      if (bundles.length === 0 || maps.length === 0)
        return {
          passed: false,
          detail: `${path} must contain a nonempty JavaScript bundle and a nonempty version-3 source map`,
        };
      for (const map of maps) await decodeSourceMap(JSON.parse(await readFile(map, "utf8")));
    }
    return { passed: true, detail: `validated source-map artifacts in ${paths.join(", ")}` };
  } catch {
    return {
      passed: false,
      detail:
        "declared source-map paths must contain regular, nonempty, parseable version-3 artifacts inside the application root",
    };
  }
};

const verifyRelease = Effect.fn("verifyRelease")(function* (directory: string) {
  const target = yield* resolveSetupTarget(directory);
  yield* checkSetupPaths(target.directory, []);
  const record = yield* Effect.tryPromise(() => readRecord(target.directory)).pipe(
    Effect.mapError((cause) =>
      fail("OBS_SETUP_INPUT_INVALID", "The setup decision record is unreadable.", cause),
    ),
  );
  if (record === undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "observability/setup.json is required before release verification.",
      "setup.json",
    );
  const input = decisionInput(record);
  if (!(input.profile === "react-web" && input.defects)) {
    const steps: ReadonlyArray<ReleasePrerequisiteStep> = [
      { name: "declaration", status: "not-applicable", detail: "source maps are not selected" },
      { name: "uploader", status: "not-applicable", detail: "source maps are not selected" },
      { name: "artifacts", status: "not-applicable", detail: "source maps are not selected" },
    ];
    return { ...target, steps, passed: true } satisfies ReleasePrerequisiteReport;
  }
  if (record.version === 1 || input.sourceMapBuild === undefined) {
    const steps: ReadonlyArray<ReleasePrerequisiteStep> = [
      {
        name: "declaration",
        status: "blocked",
        detail: "explicit setup write with source-map build declarations is required",
      },
      { name: "uploader", status: "blocked", detail: "release declaration is unavailable" },
      { name: "artifacts", status: "blocked", detail: "release declaration is unavailable" },
    ];
    return { ...target, steps, passed: false } satisfies ReleasePrerequisiteReport;
  }
  yield* checkSetupPaths(target.directory, ["package.json"]);
  const declaration = yield* Effect.promise(() =>
    inspectReleaseDeclaration(target.directory, input.sourceMapBuild?.script ?? ""),
  );
  const uploader = yield* Effect.promise(() => inspectUploader(target.directory));
  const artifacts = yield* Effect.promise(() =>
    inspectArtifacts(target.directory, input.sourceMapBuild?.includePaths ?? []),
  );
  const steps: ReadonlyArray<ReleasePrerequisiteStep> = [
    {
      name: "declaration",
      status: declaration.passed ? "passed" : "blocked",
      detail: declaration.detail,
    },
    { name: "uploader", status: uploader.passed ? "passed" : "blocked", detail: uploader.detail },
    {
      name: "artifacts",
      status: artifacts.passed ? "passed" : "blocked",
      detail: artifacts.detail,
    },
  ];
  return {
    ...target,
    steps,
    passed: steps.every((step) => step.status === "passed" || step.status === "not-applicable"),
  } satisfies ReleasePrerequisiteReport;
});

export class SetupGenerator extends Context.Service<
  SetupGenerator,
  {
    readonly plan: (
      directory: string,
      input: SetupInputEncoded,
      installDependencies?: boolean,
    ) => Effect.Effect<SetupPlan, SetupError>;
    readonly write: (
      directory: string,
      input: SetupInputEncoded,
      force: boolean,
      installDependencies?: boolean,
    ) => Effect.Effect<SetupPlan, SetupError>;
    readonly install: (plan: SetupPlan) => Effect.Effect<SetupVerificationStep, SetupError>;
    readonly verifyRelease: (
      directory: string,
    ) => Effect.Effect<ReleasePrerequisiteReport, SetupError>;
    readonly verify: (
      directory: string,
      environment: string | undefined,
      reconcile: boolean,
      conform: boolean,
      providerRead: boolean,
      target?: "local" | "deployed",
    ) => Effect.Effect<SetupVerificationReport, SetupError>;
  }
>()("@equipe-tech/observability-cli/SetupGenerator") {
  static readonly layer = Layer.succeed(
    SetupGenerator,
    SetupGenerator.of({
      plan: planSetup,
      write: writeSetup,
      install: installSetup,
      verifyRelease,
      verify: verifySetup,
    }),
  );
}
