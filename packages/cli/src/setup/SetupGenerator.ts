import { Context, Effect, Layer, Schema } from "effect";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
const Pipeline = Schema.Literal("github-actions");
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
  sentryOrganization: Schema.optional(Schema.NonEmptyString),
  sentryProject: Schema.optional(Schema.NonEmptyString),
  pipeline: Pipeline,
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
  readonly sentryOrganization: string | undefined;
  readonly sentryProject: string | undefined;
  readonly pipeline: string;
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
};
export type SetupPlan = {
  readonly directory: string;
  readonly input: SetupInput;
  readonly packages: ReadonlyArray<string>;
  readonly files: ReadonlyArray<SetupPlannedFile>;
};
export type SetupVerificationStep = {
  readonly name: "contract" | "providers" | "conformance" | "browser-route" | "sentry";
  readonly status: "passed" | "failed" | "blocked" | "not-applicable";
  readonly detail: string;
  readonly exitCode?: number;
};
export type SetupVerificationReport = {
  readonly profile: ProfileName;
  readonly directory: string;
  readonly filesystemEffects: ReadonlyArray<string>;
  readonly providerReads: ReadonlyArray<string>;
  readonly providerMutations: readonly [];
  readonly steps: ReadonlyArray<SetupVerificationStep>;
  readonly passed: boolean;
};

const DecisionRecord = Schema.Struct({
  version: Schema.Literal(1),
  profile: ProfileNameSchema,
  input: SetupInputDocument,
  packages: Schema.Array(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      ownership: Schema.Literals(["skill-owned", "user-preserved"]),
      digest: Schema.String,
    }),
  ),
});
type DecisionRecord = typeof DecisionRecord.Type;
const decodeDecisionRecord = Schema.decodeUnknownPromise(DecisionRecord, {
  onExcessProperty: "error",
});
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
  ]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const fail = (code: SetupError["code"], message: string, cause: unknown): SetupError =>
  new SetupError({ code, message, cause });

const digest = (content: string): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");
const json = <Value>(value: Value): string => `${JSON.stringify(value, undefined, 2)}\n`;
const optional = <Value>(value: Value | undefined): Value | null => value ?? null;

const packagesFor = (input: SetupInput): ReadonlyArray<string> => {
  const packages = new Set<string>([
    "@equipe-tech/observability",
    "@equipe-tech/observability-cli",
  ]);
  if (input.profile === "nestjs-api") packages.add("@equipe-tech/observability-nestjs");
  if (input.profile === "worker" || input.profile === "cli" || input.profile === "nestjs-api")
    packages.add("@equipe-tech/observability-evlog");
  if (input.profile === "react-web" || input.browserIngest)
    packages.add("@equipe-tech/observability-react");
  if (input.defects) {
    packages.add("@equipe-tech/observability-sentry");
    packages.add(input.profile === "react-web" ? "@sentry/browser" : "@sentry/node-core");
  }
  if (input.profile !== "library") packages.add("effect");
  return [...packages].toSorted();
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

const nodeCanarySource = (): string => `export {};

const command = process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND;
if (command === undefined) throw new Error("OBSERVABILITY_APPLICATION_CANARY_COMMAND is required.");
const child = Bun.spawn(["bash", "-lc", command], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
`;

const sourceMapSource = (
  input: SetupInput,
): string => `import { sentrySourceMapUpload } from "@equipe-tech/observability-sentry";

const release = process.env[${JSON.stringify(input.releaseVariable)}];
if (release === undefined) throw new Error(${JSON.stringify(`${input.releaseVariable} is required.`)});
const plan = sentrySourceMapUpload({
  organization: ${JSON.stringify(input.sentryOrganization)},
  project: ${JSON.stringify(input.sentryProject)},
  release,
  includePaths: ["dist"],
});
process.stdout.write(JSON.stringify(plan) + "\\n");
`;

const workflowSource = (input: SetupInput): string => {
  const browser = input.browserIngest ? "      - run: bun observability/browser-canary.ts\n" : "";
  const sentry =
    input.profile === "react-web" && input.defects
      ? "      - run: bun observability/source-maps.ts\n"
      : "";
  const browserEnvironment = input.browserIngest
    ? "      OBSERVABILITY_BROWSER_CANARY_ENDPOINT: ${{ secrets.OBSERVABILITY_BROWSER_CANARY_ENDPOINT }}\n"
    : "";
  const sentryEnvironment = input.defects
    ? "      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}\n"
    : "";
  return `name: observability
on:
  pull_request:
  push:
    tags:
      - "v*"
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun ./node_modules/@equipe-tech/observability-cli/dist/main.js setup verify --dir . --conform
  release-canary:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    needs: verify
    env:
      ${input.releaseVariable}: \${{ github.ref_name }}
      OBSERVABILITY_APPLICATION_CANARY_COMMAND: \${{ secrets.OBSERVABILITY_APPLICATION_CANARY_COMMAND }}
${browserEnvironment}${sentryEnvironment}    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun observability/canary.ts
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

const renderedFiles = (
  input: SetupInput,
  packages: ReadonlyArray<string>,
): ReadonlyArray<Omit<SetupPlannedFile, "action">> => {
  const serviceName = input.serviceName ?? "library";
  const files: Array<Omit<SetupPlannedFile, "action">> = [
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
      content: json({ packages }),
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

const officialProfiles = new Set<string>(Object.keys(observabilityProfiles));

const validateInput = Effect.fn("validateSetupInput")(function* (encoded: SetupInputEncoded) {
  if (!officialProfiles.has(encoded.profile)) {
    return yield* fail(
      "OBS_SETUP_PROFILE_INVALID",
      `Profile ${encoded.profile} is not official. Select nestjs-api, worker, react-web, cli, or library.`,
      encoded.profile,
    );
  }
  const input = yield* decodeSetupInput(encoded).pipe(
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
    (input.otlpEndpoint.username.length > 0 || input.otlpEndpoint.password.length > 0)
  )
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "The OTLP endpoint must not contain credentials.",
      "otlp-endpoint",
    );
  if (input.browserIngest && input.publicOrigin === undefined)
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--public-origin is required when browser ingest is selected.",
      "public-origin",
    );
  if (input.publicOrigin !== undefined && input.publicOrigin.protocol !== "https:")
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "The published browser origin must use HTTPS.",
      "public-origin",
    );
  if (["SENTRY_RELEASE", "OTEL_SERVICE_RELEASE"].includes(input.releaseVariable))
    return yield* fail(
      "OBS_SETUP_INPUT_INVALID",
      "Use OTEL_SERVICE_VERSION as the canonical release variable.",
      "release-variable",
    );
  if (
    input.profile === "react-web" &&
    input.defects &&
    (input.sentryOrganization === undefined || input.sentryProject === undefined)
  )
    return yield* fail(
      "OBS_SETUP_INPUT_MISSING",
      "--sentry-org and --sentry-project are required for React source maps.",
      "sentry-source-maps",
    );
  return input;
});

const classify = async (
  directory: string,
  rendered: ReadonlyArray<Omit<SetupPlannedFile, "action">>,
  record: DecisionRecord | undefined,
): Promise<ReadonlyArray<SetupPlannedFile>> => {
  const recorded = new Map(record?.files.map((file) => [file.path, file]));
  const files: Array<SetupPlannedFile> = [];
  for (const file of rendered) {
    const current = await readText(join(directory, file.path));
    if (current === undefined) files.push({ ...file, action: "create" });
    else if (current === file.content) files.push({ ...file, action: "unchanged" });
    else if (
      recorded.get(file.path)?.digest === digest(current) &&
      file.ownership === "skill-owned"
    )
      files.push({ ...file, action: "updated" });
    else if (file.ownership === "user-preserved" && recorded.has(file.path))
      files.push({ ...file, action: "preserved" });
    else files.push({ ...file, action: "conflict" });
  }
  return files;
};

const planSetup = Effect.fn("planSetup")(function* (directory: string, encoded: SetupInputEncoded) {
  const input = yield* validateInput(encoded);
  const root = resolve(directory);
  const packages = packagesFor(input);
  const files = yield* Effect.tryPromise(() =>
    readRecord(root).then((record) => classify(root, renderedFiles(input, packages), record)),
  ).pipe(
    Effect.mapError((cause) =>
      fail("OBS_SETUP_INPUT_INVALID", "The existing setup decision record is unreadable.", cause),
    ),
  );
  return { directory: root, input, packages, files } satisfies SetupPlan;
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

const atomicWrite = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const writeSetup = Effect.fn("writeSetup")(function* (
  directory: string,
  encoded: SetupInputEncoded,
  force: boolean,
) {
  const plan = yield* planSetup(directory, encoded);
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
    (file) => file.action === "conflict" && !(force && file.ownership === "skill-owned"),
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
      (force && file.action === "conflict" && file.ownership === "skill-owned"),
  );
  yield* Effect.tryPromise(async () => {
    for (const file of writable) await atomicWrite(join(plan.directory, file.path), file.content);
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
      version: 1,
      profile: plan.input.profile,
      input: plan.input,
      packages: [...plan.packages],
      files: finalFiles,
    });
    await atomicWrite(join(plan.directory, "observability/setup.json"), record);
  }).pipe(
    Effect.mapError((cause) =>
      fail(
        "OBS_SETUP_CONFLICT",
        "Setup could not write the complete application composition. Review filesystem permissions and retry.",
        cause,
      ),
    ),
  );
  return {
    ...plan,
    files: plan.files.map((file): SetupPlannedFile => {
      if (force && file.action === "conflict" && file.ownership === "skill-owned") {
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

const runCommand = async (
  command: ReadonlyArray<string>,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly output: string }> => {
  const child = Bun.spawn([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: commandOutput(stdout, stderr, exitCode) };
};

const verifySetup = Effect.fn("verifySetup")(function* (
  directory: string,
  environment: string | undefined,
  reconcile: boolean,
  conform: boolean,
) {
  const root = resolve(directory);
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
  const steps: Array<SetupVerificationStep> = [];
  const filesystemEffects: Array<string> = [];
  if (reconcile) {
    const result = yield* Effect.promise(() =>
      runCommand([process.execPath, "observability/contract-index.ts"], root),
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
  const selectedEnvironment = environment ?? record.input.environments[0];
  if (record.profile === "library")
    steps.push({
      name: "providers",
      status: "not-applicable",
      detail: "library has no provider resources",
    });
  else if (selectedEnvironment === undefined)
    steps.push({ name: "providers", status: "blocked", detail: "no environment was declared" });
  else
    steps.push({
      name: "providers",
      status: "blocked",
      detail: `provider read-back was not run because this task has no provider credentials for ${selectedEnvironment}`,
    });
  if (conform) {
    const result = yield* Effect.promise(() =>
      runCommand([process.execPath, "observability/conformance.ts"], root),
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
    status: record.input.browserIngest ? "blocked" : "not-applicable",
    detail: record.input.browserIngest
      ? "published browser-route verification requires the application release transport"
      : "browser ingest is not selected",
  });
  steps.push({
    name: "sentry",
    status: record.input.defects ? "blocked" : "not-applicable",
    detail: record.input.defects
      ? "Sentry verification requires the application release transport"
      : "defects are not selected",
  });
  const passed = steps.every(
    (step) => step.status === "passed" || step.status === "not-applicable",
  );
  return {
    profile: record.profile,
    directory: root,
    filesystemEffects,
    providerReads: [],
    providerMutations: [],
    steps,
    passed,
  } satisfies SetupVerificationReport;
});

export class SetupGenerator extends Context.Service<
  SetupGenerator,
  {
    readonly plan: (
      directory: string,
      input: SetupInputEncoded,
    ) => Effect.Effect<SetupPlan, SetupError>;
    readonly write: (
      directory: string,
      input: SetupInputEncoded,
      force: boolean,
    ) => Effect.Effect<SetupPlan, SetupError>;
    readonly verify: (
      directory: string,
      environment: string | undefined,
      reconcile: boolean,
      conform: boolean,
    ) => Effect.Effect<SetupVerificationReport, SetupError>;
  }
>()("@equipe-tech/observability-cli/SetupGenerator") {
  static readonly layer = Layer.succeed(
    SetupGenerator,
    SetupGenerator.of({ plan: planSetup, write: writeSetup, verify: verifySetup }),
  );
}
