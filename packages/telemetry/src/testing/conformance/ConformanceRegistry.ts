import type { Effect } from "effect";
import type { ConformanceFailureCode } from "./ConformanceFailure.ts";
import type {
  ConformanceCheckId,
  ConformanceEvidence,
  ConformanceEvidenceProvider,
  ConformanceOwner,
  ConformanceTargetContext,
  ConformanceViolation,
  SourceRuleReference,
} from "./ConformanceModel.ts";

export type ConformanceCheck = {
  readonly id: ConformanceCheckId;
  readonly owner: ConformanceOwner;
  readonly code: ConformanceFailureCode;
  readonly rule: SourceRuleReference;
  readonly applies: (target: ConformanceTargetContext) => boolean;
  readonly notApplicableReason: (target: ConformanceTargetContext) => string;
  readonly run: (
    target: ConformanceTargetContext,
    provider: ConformanceEvidenceProvider<ConformanceCheckId>,
  ) => Effect.Effect<ConformanceEvidence, ConformanceViolation>;
};

const rule = (document: string, heading: string): SourceRuleReference => ({
  document,
  heading,
});

const profilesRule = rule("docs/profiles.md", "Perfis oficiais de observabilidade");
const nodeConfigRule = rule("docs/profiles.md", "Configuração de Node");
const contractRule = rule("docs/telemetry-contract.md", "Contrato de telemetria");
const manifestRule = rule("docs/operations-manifest.md", "Manifesto de operações");
const emitReceiptRule = rule("docs/telemetry-contract.md", "Recibo de emissão");
const managedQueriesRule = rule("docs/operations-manifest.md", "Queries gerenciadas");
const correlationRule = rule("docs/telemetry-contract.md", "Correlação tipada");
const policyRule = rule("docs/data-policy.md", "Declaração da política");
const sentryRule = rule("docs/sentry-adapters.md", "Adaptadores Sentry");
const lifecycleRule = rule("docs/profiles.md", "Ciclo de vida");
const auditRule = rule("docs/audit.md", "Ordem durável");
const boundariesRule = rule("docs/coding-standards.md", "Fronteiras do monorepo");
const canaryRule = rule("docs/testing.md", "Canário do pipeline");
const browserRule = rule("docs/profiles.md", "Runtime React web");

const manifestProfiles = new Set(["nestjs-api", "worker", "react-web", "cli"]);
const serverEventProfiles = new Set(["nestjs-api", "worker", "cli"]);
const nodeCanaryProfiles = new Set(["nestjs-api", "worker", "cli"]);

const capabilitiesSummary = (target: ConformanceTargetContext): string =>
  [
    target.capabilities.traces ? "traces" : undefined,
    target.capabilities.metrics ? "metrics" : undefined,
    target.capabilities.defects ? "defects" : undefined,
    target.capabilities.browserIngest ? "browser-ingest" : undefined,
    target.capabilities.audit ? "audit" : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(",");

const notApplicableWithoutCapability = (capability: string) => (target: ConformanceTargetContext) =>
  `the target does not select the ${capability} capability (selected: ${capabilitiesSummary(target)})`;

export const conformanceChecks: ReadonlyArray<ConformanceCheck> = Object.freeze([
  {
    id: "profile.official",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_PROFILE_INVALID",
    rule: profilesRule,
    applies: () => true,
    notApplicableReason: () => "every target must prove one official profile",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "identity.canonical",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_IDENTITY_INVALID",
    rule: nodeConfigRule,
    applies: (target) => target.profile.name !== "library",
    notApplicableReason: () =>
      "the library profile owns no runtime resource identity",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "contract.compiles",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_CONTRACT_INVALID",
    rule: contractRule,
    applies: () => true,
    notApplicableReason: () => "every application must compile its telemetry contract",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "manifest.valid",
    owner: "cli",
    code: "OBS_CONFORMANCE_MANIFEST_INVALID",
    rule: manifestRule,
    applies: (target) => manifestProfiles.has(target.profile.name),
    notApplicableReason: () => "the library profile declares no operations manifest",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "producers.contract-derived",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_PRODUCER_INVALID",
    rule: emitReceiptRule,
    applies: (target) => target.profile.events !== "forbidden",
    notApplicableReason: () => "the library profile forbids events and producers",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "queries.contract-derived",
    owner: "cli",
    code: "OBS_CONFORMANCE_QUERY_INVALID",
    rule: managedQueriesRule,
    applies: (target) => manifestProfiles.has(target.profile.name),
    notApplicableReason: () => "the library profile declares no managed queries",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "correlation.canonical",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_CORRELATION_INVALID",
    rule: correlationRule,
    applies: (target) =>
      target.profile.events !== "forbidden" || target.profile.traces !== "forbidden",
    notApplicableReason: () =>
      "the library profile emits no events and no traces to correlate",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "policy.compiles",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_POLICY_INVALID",
    rule: policyRule,
    applies: (target) =>
      target.profile.events !== "forbidden" ||
      target.profile.traces !== "forbidden" ||
      target.profile.metrics !== "forbidden",
    notApplicableReason: () => "the library profile exports no runtime signals",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "server-events.evlog-collector",
    owner: "evlog",
    code: "OBS_CONFORMANCE_EVENT_PATH_INVALID",
    rule: nodeConfigRule,
    applies: (target) => serverEventProfiles.has(target.profile.name),
    notApplicableReason: () =>
      "the profile owns no Node server event path through evlog and the Collector",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "sentry.unexpected-defects-only",
    owner: "sentry",
    code: "OBS_CONFORMANCE_SENTRY_BOUNDARY_INVALID",
    rule: sentryRule,
    applies: (target) => target.capabilities.defects,
    notApplicableReason: notApplicableWithoutCapability("defects"),
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "lifecycle.profile-compliant",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_LIFECYCLE_INVALID",
    rule: lifecycleRule,
    applies: () => true,
    notApplicableReason: () => "every target proves lifecycle compliance or runtime absence",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "audit.durable-before-operational",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_AUDIT_DURABILITY_MISSING",
    rule: auditRule,
    applies: (target) => target.capabilities.audit,
    notApplicableReason: notApplicableWithoutCapability("audit"),
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "pipeline.no-application-otlp",
    owner: "cli",
    code: "OBS_CONFORMANCE_LOCAL_OTLP_PIPELINE",
    rule: boundariesRule,
    applies: () => true,
    notApplicableReason: () => "every application source tree must reject local OTLP pipelines",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "canary.telemetry-destination",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_TELEMETRY_CANARY_FAILED",
    rule: canaryRule,
    applies: (target) => nodeCanaryProfiles.has(target.profile.name),
    notApplicableReason: () =>
      "the profile owns no Node runtime pipeline canary for an exported signal",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "canary.sentry",
    owner: "sentry",
    code: "OBS_CONFORMANCE_SENTRY_CANARY_FAILED",
    rule: sentryRule,
    applies: (target) => target.capabilities.defects,
    notApplicableReason: notApplicableWithoutCapability("defects"),
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "canary.browser-route",
    owner: "react",
    code: "OBS_CONFORMANCE_BROWSER_CANARY_FAILED",
    rule: browserRule,
    applies: (target) =>
      target.profile.name === "react-web" && target.capabilities.browserIngest,
    notApplicableReason: (target) =>
      target.profile.name === "react-web"
        ? notApplicableWithoutCapability("browser-ingest")(target)
        : "the browser delivery canary applies to the react-web profile only",
    run: (target, provider) => provider.verify(target),
  },
  {
    id: "canary.audit",
    owner: "telemetry",
    code: "OBS_CONFORMANCE_AUDIT_CANARY_FAILED",
    rule: auditRule,
    applies: (target) => target.capabilities.audit,
    notApplicableReason: notApplicableWithoutCapability("audit"),
    run: (target, provider) => provider.verify(target),
  },
] satisfies ReadonlyArray<ConformanceCheck>);
