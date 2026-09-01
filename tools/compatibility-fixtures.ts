import { Contract } from "../packages/telemetry/src/index.ts";
import {
  type DeclaredPackageBreak,
  type PackageCompatibilityCode,
  type PackageSurface,
} from "../scripts/compatibility-gate.ts";

type ContractExpected = {
  readonly code: Contract.CompatibilityCode;
  readonly path: string;
  readonly severity: Contract.CompatibilitySeverity;
  readonly aliasStatus: Contract.CompatibilityAliasStatus;
  readonly accepted: boolean;
};

type ContractCase = {
  readonly baseline: Contract.ContractSurface;
  readonly candidate: Contract.ContractSurface;
  readonly control: Contract.ContractSurface;
  readonly now: string;
};

export type ContractCompatibilityFixture = {
  readonly id: Contract.CompatibilityCode;
  readonly expected: ContractExpected;
  readonly arrange: () => ContractCase;
};

const event = {
  name: "payment.attempt",
  kind: "operation",
  outcomeMeaning: ["cancelled", "failure", "success"],
  attributes: [
    {
      name: "payment.provider",
      required: false,
      classification: "public",
      metricLabel: false,
    },
  ],
} satisfies Contract.ContractSurfaceEvent;

const metric = {
  name: "payment.latency",
  kind: "histogram",
  unit: "ms",
  boundaries: [10, 100],
  attributes: [
    {
      name: "payment.provider",
      classification: "public",
      maximumCardinality: 4,
      allowedValues: ["stripe", "adyen"],
    },
  ],
} satisfies Contract.ContractSurfaceMetric;

const action = {
  action: "payment.refund",
  resourceType: "payment",
  allowedOutcomes: ["failure", "success"],
  reasonCodes: ["duplicate", "fraud"],
} satisfies Contract.ContractSurfaceAuditAction;

const contractSurface = (): Contract.ContractSurface => ({
  surface: 1,
  service: "checkout",
  contractVersion: 1,
  events: [event],
  metrics: [metric],
  auditActions: [action],
  aliases: [],
  browserEnvelope: {
    version: 2,
    batchFields: ["version", "events"],
    eventFields: ["name", "attributes"],
  },
  retentionWindowDays: 30,
});

const contractFixture = (
  expected: ContractExpected,
  mutate: (baseline: Contract.ContractSurface) => Contract.ContractSurface,
  baselineFactory: () => Contract.ContractSurface = contractSurface,
  now = "2026-09-01",
  control: (baseline: Contract.ContractSurface) => Contract.ContractSurface = (baseline) =>
    baseline,
): ContractCompatibilityFixture => ({
  id: expected.code,
  expected,
  arrange: () => {
    const baseline = baselineFactory();
    return { baseline, candidate: mutate(baseline), control: control(baseline), now };
  },
});

const expected = (
  code: Contract.CompatibilityCode,
  path: string,
  severity: Contract.CompatibilitySeverity,
  accepted: boolean,
  aliasStatus: Contract.CompatibilityAliasStatus = "not-required",
): ContractExpected => ({ code, path, severity, aliasStatus, accepted });

const replaceEvent = (
  surface: Contract.ContractSurface,
  update: (value: Contract.ContractSurfaceEvent) => Contract.ContractSurfaceEvent,
): Contract.ContractSurface => ({ ...surface, events: surface.events.map(update) });

const replaceMetric = (
  surface: Contract.ContractSurface,
  update: (value: Contract.ContractSurfaceMetric) => Contract.ContractSurfaceMetric,
): Contract.ContractSurface => ({ ...surface, metrics: surface.metrics.map(update) });

const aliasSurface = (): Contract.ContractSurface => ({
  ...contractSurface(),
  aliases: [{ kind: "event", from: "payment.charge", to: event.name, since: "2026-08-15" }],
});

export const contractCompatibilityFixtures: ReadonlyArray<ContractCompatibilityFixture> = [
  contractFixture(
    expected("OBS_COMPAT_EVENT_ADDED", "events/payment.refund", "compatible", true),
    (baseline) => ({
      ...baseline,
      events: [...baseline.events, { ...event, name: "payment.refund" }],
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_EVENT_REMOVED", "events/payment.attempt", "breaking", false, "missing"),
    (baseline) => ({ ...baseline, events: [] }),
  ),
  contractFixture(
    expected("OBS_COMPAT_EVENT_RENAMED", "events/payment.attempt", "breaking", true, "active"),
    (baseline) => ({
      ...baseline,
      contractVersion: 2,
      events: [{ ...event, name: "payment.started" }],
      aliases: [{ kind: "event", from: event.name, to: "payment.started", since: "2026-08-31" }],
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_EVENT_KIND_CHANGED", "events/payment.attempt/kind", "breaking", true),
    (baseline) =>
      replaceEvent({ ...baseline, contractVersion: 2 }, (value) => ({ ...value, kind: "domain" })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_OUTCOME_MEANING_CHANGED",
      "events/payment.attempt/outcomeMeaning",
      "breaking",
      false,
    ),
    (baseline) =>
      replaceEvent({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        outcomeMeaning: ["failure", "success"],
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ATTRIBUTE_ADDED",
      "events/payment.attempt/attributes/payment.method",
      "compatible",
      true,
    ),
    (baseline) =>
      replaceEvent(baseline, (value) => ({
        ...value,
        attributes: [
          ...value.attributes,
          { name: "payment.method", required: false, classification: "public", metricLabel: false },
        ],
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ATTRIBUTE_REMOVED",
      "events/payment.attempt/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceEvent({ ...baseline, contractVersion: 2 }, (value) => ({ ...value, attributes: [] })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ATTRIBUTE_REQUIRED",
      "events/payment.attempt/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceEvent({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        attributes: value.attributes.map((attribute) => ({ ...attribute, required: true })),
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ATTRIBUTE_CLASSIFICATION_CHANGED",
      "events/payment.attempt/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceEvent({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        attributes: value.attributes.map((attribute) => ({
          ...attribute,
          classification: "internal",
        })),
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ATTRIBUTE_METRIC_LABEL_CHANGED",
      "events/payment.attempt/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceEvent({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        attributes: value.attributes.map((attribute) => ({ ...attribute, metricLabel: true })),
      })),
  ),
  contractFixture(
    expected("OBS_COMPAT_METRIC_ADDED", "metrics/payment.count", "compatible", true),
    (baseline) => ({
      ...baseline,
      metrics: [...baseline.metrics, { ...metric, name: "payment.count" }],
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_METRIC_REMOVED", "metrics/payment.latency", "breaking", false, "missing"),
    (baseline) => ({ ...baseline, metrics: [] }),
  ),
  contractFixture(
    expected("OBS_COMPAT_METRIC_RENAMED", "metrics/payment.latency", "breaking", true, "active"),
    (baseline) => ({
      ...baseline,
      contractVersion: 2,
      metrics: [{ ...metric, name: "payment.duration" }],
      aliases: [{ kind: "metric", from: metric.name, to: "payment.duration", since: "2026-08-31" }],
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_METRIC_KIND_CHANGED", "metrics/payment.latency/kind", "breaking", false),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        kind: "counter",
      })),
  ),
  contractFixture(
    expected("OBS_COMPAT_METRIC_UNIT_CHANGED", "metrics/payment.latency/unit", "breaking", false),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({ ...value, unit: "s" })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_METRIC_BOUNDARIES_CHANGED",
      "metrics/payment.latency/boundaries",
      "breaking",
      false,
    ),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        boundaries: [10, 50],
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_METRIC_ATTRIBUTE_ADDED",
      "metrics/payment.latency/attributes/payment.method",
      "compatible",
      true,
    ),
    (baseline) =>
      replaceMetric(baseline, (value) => ({
        ...value,
        attributes: [
          ...value.attributes,
          {
            name: "payment.method",
            classification: "public",
            maximumCardinality: 2,
            allowedValues: [],
          },
        ],
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_METRIC_ATTRIBUTE_REMOVED",
      "metrics/payment.latency/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({ ...value, attributes: [] })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_METRIC_ATTRIBUTE_CLASSIFICATION_CHANGED",
      "metrics/payment.latency/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        attributes: value.attributes.map((attribute) => ({
          ...attribute,
          classification: "internal",
        })),
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_METRIC_CARDINALITY_LOWERED",
      "metrics/payment.latency/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        attributes: value.attributes.map((attribute) => ({ ...attribute, maximumCardinality: 2 })),
      })),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_METRIC_ALLOWED_VALUES_NARROWED",
      "metrics/payment.latency/attributes/payment.provider",
      "breaking",
      true,
    ),
    (baseline) =>
      replaceMetric({ ...baseline, contractVersion: 2 }, (value) => ({
        ...value,
        attributes: value.attributes.map((attribute) => ({
          ...attribute,
          allowedValues: ["stripe"],
        })),
      })),
  ),
  contractFixture(
    expected("OBS_COMPAT_AUDIT_ACTION_ADDED", "auditActions/payment.capture", "compatible", true),
    (baseline) => ({
      ...baseline,
      auditActions: [...baseline.auditActions, { ...action, action: "payment.capture" }],
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_AUDIT_ACTION_REMOVED", "auditActions/payment.refund", "breaking", true),
    (baseline) => ({ ...baseline, contractVersion: 2, auditActions: [] }),
  ),
  contractFixture(
    expected("OBS_COMPAT_AUDIT_ACTION_CHANGED", "auditActions/payment.refund", "breaking", true),
    (baseline) => ({
      ...baseline,
      contractVersion: 2,
      auditActions: baseline.auditActions.map((value) => ({
        ...value,
        reasonCodes: ["duplicate"],
      })),
    }),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ALIAS_ADDED",
      "aliases/event/payment.charge/payment.attempt",
      "compatible",
      true,
      "active",
    ),
    (baseline) => ({
      ...baseline,
      aliases: [{ kind: "event", from: "payment.charge", to: event.name, since: "2026-08-31" }],
    }),
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ALIAS_REMOVED_EARLY",
      "aliases/event/payment.charge/payment.attempt",
      "breaking",
      false,
      "active",
    ),
    (baseline) => ({ ...baseline, contractVersion: 2, aliases: [] }),
    aliasSurface,
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ALIAS_WINDOW_RESET",
      "aliases/event/payment.charge/payment.attempt/since",
      "breaking",
      false,
      "active",
    ),
    (baseline) => ({
      ...baseline,
      contractVersion: 2,
      aliases: baseline.aliases.map((value) => ({ ...value, since: "2026-08-20" })),
    }),
    aliasSurface,
  ),
  contractFixture(
    expected(
      "OBS_COMPAT_ALIAS_WINDOW_EXPIRED",
      "aliases/event/payment.charge/payment.attempt",
      "notice",
      true,
      "expired",
    ),
    (baseline) => baseline,
    aliasSurface,
    "2026-09-14",
    (baseline) => ({
      ...baseline,
      aliases: baseline.aliases.map((value) => ({ ...value, since: "2026-08-16" })),
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_BROWSER_ENVELOPE_CHANGED", "browserEnvelope", "breaking", false),
    (baseline) => ({
      ...baseline,
      contractVersion: 2,
      browserEnvelope: {
        ...baseline.browserEnvelope,
        eventFields: [...baseline.browserEnvelope.eventFields, "sessionId"],
      },
    }),
  ),
  contractFixture(
    expected("OBS_COMPAT_RETENTION_WINDOW_RESET", "retentionWindowDays", "breaking", false),
    (baseline) => ({ ...baseline, contractVersion: 2, retentionWindowDays: 29 }),
  ),
];

type PackageExpected = {
  readonly code: PackageCompatibilityCode;
  readonly path: string;
  readonly severity: "compatible" | "breaking";
  readonly accepted: boolean;
};

export type PackageCompatibilityFixture = {
  readonly id: PackageCompatibilityCode;
  readonly baseline: PackageSurface;
  readonly candidate: PackageSurface;
  readonly control: PackageSurface;
  readonly declaredVersion: string;
  readonly declaredBreaks: ReadonlyArray<DeclaredPackageBreak>;
  readonly expected: PackageExpected;
};

const packageSurface = (): PackageSurface => ({
  name: "@equipe-tech/example",
  version: "0.2.1",
  type: "module",
  exports: ["."],
  exportConditions: [".:import:./dist/index.js"],
  runtimeEntrypoints: ["."],
  declarationSymbols: [".:Example"],
  dependencies: ["effect@^4.0.0"],
  peerDependencies: ["vite@^6.0.0"],
  optionalPeers: ["vite"],
  publicErrorCodes: ["OBS_EXAMPLE_FAILED"],
});

const packageFixture = (
  expectedValue: PackageExpected,
  mutate: (baseline: PackageSurface) => PackageSurface,
  declaredVersion = expectedValue.severity === "compatible" ? "0.2.2" : "0.3.0",
  declaredBreaks: ReadonlyArray<DeclaredPackageBreak> = [],
): PackageCompatibilityFixture => {
  const baseline = packageSurface();
  return {
    id: expectedValue.code,
    baseline,
    candidate: mutate(baseline),
    control: baseline,
    declaredVersion,
    declaredBreaks,
    expected: expectedValue,
  };
};

const packageExpected = (
  code: PackageCompatibilityCode,
  path: string,
  severity: "compatible" | "breaking",
  accepted = severity === "compatible",
): PackageExpected => ({ code, path, severity, accepted });

export const packageCompatibilityFixtures: ReadonlyArray<PackageCompatibilityFixture> = [
  packageFixture(
    packageExpected("OBS_PACKAGE_EXPORT_ADDED", "exports/./testing", "compatible"),
    (baseline) => ({ ...baseline, exports: [...baseline.exports, "./testing"] }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_EXPORT_REMOVED", "exports/.", "breaking"),
    (baseline) => ({ ...baseline, exports: [] }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_SYMBOL_ADDED", "symbols/.:Extra", "compatible"),
    (baseline) => ({
      ...baseline,
      declarationSymbols: [...baseline.declarationSymbols, ".:Extra"],
    }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_SYMBOL_REMOVED", "symbols/.:Example", "breaking"),
    (baseline) => ({ ...baseline, declarationSymbols: [] }),
  ),
  packageFixture(
    packageExpected(
      "OBS_PACKAGE_DEPENDENCY_ADDED",
      "dependencies/yuku-parser@^0.5.0",
      "compatible",
    ),
    (baseline) => ({ ...baseline, dependencies: [...baseline.dependencies, "yuku-parser@^0.5.0"] }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_DEPENDENCY_REMOVED", "dependencies/effect@^4.0.0", "breaking"),
    (baseline) => ({ ...baseline, dependencies: [] }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_DEPENDENCY_CATEGORY_CHANGED", "dependencies/effect", "breaking"),
    (baseline) => ({
      ...baseline,
      dependencies: [],
      peerDependencies: [...baseline.peerDependencies, "effect@^4.0.0"],
    }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_PEER_ADDED", "peerDependencies/react@^19.0.0", "compatible"),
    (baseline) => ({
      ...baseline,
      peerDependencies: [...baseline.peerDependencies, "react@^19.0.0"],
    }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_PEER_CHANGED", "peerDependencies/vite@^6.0.0->^7.0.0", "breaking"),
    (baseline) => ({ ...baseline, peerDependencies: ["vite@^7.0.0"] }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_RUNTIME_ENTRYPOINT_MISSING", "runtime/.", "breaking"),
    (baseline) => ({ ...baseline, runtimeEntrypoints: [] }),
  ),
  packageFixture(packageExpected("OBS_PACKAGE_NAME_CHANGED", "name", "breaking"), (baseline) => ({
    ...baseline,
    name: "@equipe-tech/renamed",
  })),
  packageFixture(packageExpected("OBS_PACKAGE_TYPE_CHANGED", "type", "breaking"), (baseline) => ({
    ...baseline,
    type: "commonjs",
  })),
  packageFixture(
    packageExpected(
      "OBS_PACKAGE_EXPORT_CONDITION_ADDED",
      "exportConditions/.:types:./dist/index.d.ts",
      "compatible",
    ),
    (baseline) => ({
      ...baseline,
      exportConditions: [...baseline.exportConditions, ".:types:./dist/index.d.ts"],
    }),
  ),
  packageFixture(
    packageExpected(
      "OBS_PACKAGE_EXPORT_CONDITION_REMOVED",
      "exportConditions/.:import:./dist/index.js",
      "breaking",
    ),
    (baseline) => ({ ...baseline, exportConditions: [] }),
  ),
  packageFixture(
    packageExpected("OBS_PACKAGE_PEER_OPTIONALITY_CHANGED", "peerDependenciesMeta", "breaking"),
    (baseline) => ({ ...baseline, optionalPeers: [] }),
  ),
  packageFixture(
    packageExpected(
      "OBS_PACKAGE_ERROR_CODE_ADDED",
      "publicErrorCodes/OBS_EXAMPLE_RETRY",
      "compatible",
    ),
    (baseline) => ({
      ...baseline,
      publicErrorCodes: [...baseline.publicErrorCodes, "OBS_EXAMPLE_RETRY"],
    }),
  ),
  packageFixture(
    packageExpected(
      "OBS_PACKAGE_ERROR_CODE_REMOVED",
      "publicErrorCodes/OBS_EXAMPLE_FAILED",
      "breaking",
    ),
    (baseline) => ({ ...baseline, publicErrorCodes: [] }),
  ),
];
