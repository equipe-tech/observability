import { Effect, Schema } from "effect";
import { EnvironmentName, ServiceName, resourceNamePattern } from "./ResourceNamePolicy.ts";
import { ManagedQueryError, parseManagedQuery, type ManagedQuery } from "./ManagedQuery.ts";

const Identifier = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(63),
);
const Title = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const QueryText = Schema.NonEmptyString.check(Schema.isMaxLength(16_384));
const PositiveDays = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_650));

export class SignalReference extends Schema.Class<SignalReference>(
  "@equipe-tech/observability-cli/SignalReference",
)({
  kind: Schema.Literals(["event", "metric"]),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
}) {}

export class RetentionDefinition extends Schema.Class<RetentionDefinition>(
  "@equipe-tech/observability-cli/RetentionDefinition",
)({ environment: EnvironmentName, days: PositiveDays }) {}

export class PanelDefinition extends Schema.Class<PanelDefinition>(
  "@equipe-tech/observability-cli/PanelDefinition",
)({
  id: Identifier,
  title: Title,
  sources: Schema.Array(SignalReference).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  query: QueryText,
}) {}

export class DashboardDefinition extends Schema.Class<DashboardDefinition>(
  "@equipe-tech/observability-cli/DashboardDefinition",
)({
  id: Identifier,
  title: Title,
  panels: Schema.Array(PanelDefinition).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}) {}

export class MonitorDefinition extends Schema.Class<MonitorDefinition>(
  "@equipe-tech/observability-cli/MonitorDefinition",
)({
  id: Identifier,
  title: Title,
  source: SignalReference,
  query: QueryText,
  threshold: Schema.Finite,
}) {}

export class OperationsManifest extends Schema.Class<OperationsManifest>(
  "@equipe-tech/observability-cli/OperationsManifest",
)({
  version: Schema.Literal(1),
  contractVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  service: ServiceName,
  environments: Schema.Array(EnvironmentName).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  retention: Schema.Array(RetentionDefinition),
  dashboards: Schema.Array(DashboardDefinition),
  monitors: Schema.Array(MonitorDefinition),
  sentry: Schema.Struct({ enabled: Schema.Boolean }),
}) {}

const ContractIndexEventAttribute = Schema.Struct({
  name: Schema.NonEmptyString,
  classification: Schema.Literals(["public", "internal", "sensitive", "forbidden"]),
});
const ContractIndexEvent = Schema.Struct({
  name: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  attributes: Schema.Array(Schema.NonEmptyString),
  attributeClassifications: Schema.Array(ContractIndexEventAttribute),
});
const ContractIndexMetric = Schema.Struct({
  name: Schema.NonEmptyString,
  kind: Schema.Literals(["counter", "histogram", "observable_gauge"]),
  unit: Schema.String,
  attributes: Schema.Array(Schema.NonEmptyString),
});
const ContractIndexAlias = Schema.Struct({
  kind: Schema.Literals(["event", "metric"]),
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
});
export const OperationsContractIndex = Schema.Struct({
  index: Schema.Literal(1),
  contractVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  service: ServiceName,
  events: Schema.Array(ContractIndexEvent),
  metrics: Schema.Array(ContractIndexMetric),
  aliases: Schema.Array(ContractIndexAlias),
});
export type OperationsContractIndex = typeof OperationsContractIndex.Type;

export type ValidatedPanel = {
  readonly definition: PanelDefinition;
  readonly query: ManagedQuery;
};
export type ValidatedDashboard = {
  readonly definition: DashboardDefinition;
  readonly panels: ReadonlyArray<ValidatedPanel>;
};
export type ValidatedMonitor = {
  readonly definition: MonitorDefinition;
  readonly query: ManagedQuery;
};
export type ValidatedOperationsManifest = {
  readonly manifest: OperationsManifest;
  readonly contract: OperationsContractIndex;
  readonly dashboards: ReadonlyArray<ValidatedDashboard>;
  readonly monitors: ReadonlyArray<ValidatedMonitor>;
};

export class OperationsManifestError extends Schema.TaggedError<OperationsManifestError>()(
  "OperationsManifestError",
  {
    code: Schema.Literals([
      "OBS_CLI_MANIFEST_NOT_FOUND",
      "OBS_CLI_MANIFEST_UNREADABLE",
      "OBS_CLI_MANIFEST_VERSION_UNSUPPORTED",
      "OBS_CLI_MANIFEST_INVALID",
      "OBS_CLI_CONTRACT_INDEX_NOT_FOUND",
      "OBS_CLI_CONTRACT_INDEX_INVALID",
      "OBS_CLI_CONTRACT_INDEX_STALE",
      "OBS_CLI_SOURCE_INVALID",
    ]),
    message: Schema.String,
    issues: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {}

const manifestInvalid = (issues: ReadonlyArray<string>, cause: unknown): OperationsManifestError =>
  new OperationsManifestError({
    code: "OBS_CLI_MANIFEST_INVALID",
    message: `The operations manifest is invalid: ${issues.join("; ")}`,
    issues,
    cause,
  });

const ManifestVersion = Schema.Struct({ version: Schema.Number });
const decodeManifestVersion = Schema.decodeUnknownEffect(ManifestVersion);
const decodeManifest = Schema.decodeUnknownEffect(OperationsManifest, {
  onExcessProperty: "error",
});
const decodeContract = Schema.decodeUnknownEffect(OperationsContractIndex, {
  onExcessProperty: "error",
});

export const parseOperationsManifest = Effect.fn("parseOperationsManifest")(function* (
  content: string,
): Effect.fn.Return<OperationsManifest, OperationsManifestError> {
  if (content.length > 1_048_576) {
    return yield* manifestInvalid(["manifest exceeds 1048576 bytes"], content.length);
  }
  const document = yield* Effect.try({
    try: () => Bun.YAML.parse(content),
    catch: (cause) => manifestInvalid(["YAML could not be decoded"], cause),
  });
  const version = yield* decodeManifestVersion(document).pipe(
    Effect.mapError((cause) => manifestInvalid(["version must be an integer"], cause)),
  );
  if (version.version !== 1) {
    return yield* new OperationsManifestError({
      code: "OBS_CLI_MANIFEST_VERSION_UNSUPPORTED",
      message: `Operations manifest version ${version.version} is unsupported. Use version 1.`,
      issues: [`unsupported version ${version.version}`],
      cause: version.version,
    });
  }
  return yield* decodeManifest(document).pipe(
    Effect.mapError((cause) => manifestInvalid(["document does not match version 1"], cause)),
  );
});

export const parseOperationsContractIndex = Effect.fn("parseOperationsContractIndex")(function* (
  content: string,
): Effect.fn.Return<OperationsContractIndex, OperationsManifestError> {
  if (content.length > 4_194_304) {
    return yield* new OperationsManifestError({
      code: "OBS_CLI_CONTRACT_INDEX_INVALID",
      message: "The contract index exceeds 4194304 bytes.",
      issues: ["contract index is oversized"],
      cause: content.length,
    });
  }
  const document = yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) =>
      new OperationsManifestError({
        code: "OBS_CLI_CONTRACT_INDEX_INVALID",
        message: "The contract index is not valid JSON.",
        issues: ["invalid JSON"],
        cause,
      }),
  });
  return yield* decodeContract(document).pipe(
    Effect.mapError(
      (cause) =>
        new OperationsManifestError({
          code: "OBS_CLI_CONTRACT_INDEX_INVALID",
          message: "The contract index does not match index version 1.",
          issues: ["invalid contract index"],
          cause,
        }),
    ),
  );
});

const duplicates = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
};

type AliasKind = SignalReference["kind"];
type AliasExpansion = {
  readonly targets: ReadonlySet<string>;
  readonly cyclic: boolean;
};
type AliasGraph = {
  expand(kind: AliasKind, source: string): AliasExpansion;
};

const aliasKey = (kind: AliasKind, name: string): string => `${kind}\u0000${name}`;

const buildAliasGraph = (aliases: OperationsContractIndex["aliases"]): AliasGraph => {
  const adjacency = new Map<string, Set<string>>();
  for (const alias of aliases) {
    const key = aliasKey(alias.kind, alias.from);
    const targets = adjacency.get(key) ?? new Set<string>();
    targets.add(alias.to);
    adjacency.set(key, targets);
  }
  const colors = new Map<string, "gray" | "black">();
  const expansions = new Map<string, AliasExpansion>();
  const expand = (kind: AliasKind, source: string): AliasExpansion => {
    const key = aliasKey(kind, source);
    const cached = expansions.get(key);
    if (cached !== undefined) return cached;
    if (colors.get(key) === "gray") return { targets: new Set([source]), cyclic: true };
    colors.set(key, "gray");
    const targets = new Set([source]);
    let cyclic = false;
    for (const target of adjacency.get(key) ?? []) {
      const nested = expand(kind, target);
      for (const nestedTarget of nested.targets) targets.add(nestedTarget);
      if (nested.cyclic) cyclic = true;
    }
    const expansion = { targets, cyclic };
    colors.set(key, "black");
    expansions.set(key, expansion);
    return expansion;
  };
  for (const alias of aliases) expand(alias.kind, alias.from);
  return { expand };
};

const validateQuery = Effect.fn("validateManagedSource")(function* (
  queryText: string,
  sources: ReadonlyArray<SignalReference>,
  contract: OperationsContractIndex,
  aliases: AliasGraph,
): Effect.fn.Return<ManagedQuery, OperationsManifestError | ManagedQueryError> {
  const query = yield* parseManagedQuery(queryText);
  const kinds = new Set(sources.map((source) => source.kind));
  const sourceKind = sources[0]?.kind;
  const streamMatches =
    sourceKind === "metric"
      ? query.stream === "metrics"
      : query.stream === "logs" || query.stream === "traces";
  const expectedBinding = sourceKind === "metric" ? "metric.name" : "event.name";
  if (
    kinds.size !== 1 ||
    sourceKind === undefined ||
    !streamMatches ||
    query.binding.field !== expectedBinding
  ) {
    return yield* new OperationsManifestError({
      code: "OBS_CLI_SOURCE_INVALID",
      message: "The managed query stream does not match its declared sources.",
      issues: ["provider signal mismatch"],
      cause: query.stream,
    });
  }
  const expected = [
    ...new Set(sources.flatMap((source) => [...aliases.expand(source.kind, source.name).targets])),
  ].sort();
  const actual = [...query.binding.identifiers].sort();
  if (expected.join("\u0000") !== actual.join("\u0000")) {
    return yield* new ManagedQueryError({
      code: "OBS_CLI_QUERY_SIGNAL_MISMATCH",
      message: `The managed query signal predicate must exactly match ${expected.join(", ")}.`,
      cause: actual.join(","),
    });
  }
  const expandedSourceNames = sources.flatMap((source) => [
    ...aliases.expand(source.kind, source.name).targets,
  ]);
  const targetAttributeSets = sources.flatMap((source) => {
    const names = aliases.expand(source.kind, source.name).targets;
    return source.kind === "event"
      ? contract.events
          .filter((event) => names.has(event.name))
          .map((event) => new Set(event.attributes))
      : contract.metrics
          .filter((metric) => names.has(metric.name))
          .map((metric) => new Set(metric.attributes));
  });
  const declaredAttributes = new Set(targetAttributeSets[0] ?? []);
  for (const attributes of targetAttributeSets.slice(1)) {
    for (const attribute of declaredAttributes) {
      if (!attributes.has(attribute)) declaredAttributes.delete(attribute);
    }
  }
  for (const stage of query.stages) {
    if (stage.kind === "where") {
      const invalidField = stage.comparisons.find(
        (comparison) =>
          comparison.field !== query.binding.field && !declaredAttributes.has(comparison.field),
      );
      if (invalidField !== undefined) {
        return yield* new OperationsManifestError({
          code: "OBS_CLI_SOURCE_INVALID",
          message: `Query field ${invalidField.field} is not a declared source attribute.`,
          issues: [`undeclared query field ${invalidField.field}`],
          cause: invalidField.field,
        });
      }
      continue;
    }
    const invalidGroup = stage.groups.find(
      (group) => group.field !== "timestamp" && !declaredAttributes.has(group.field),
    );
    if (invalidGroup !== undefined) {
      return yield* new OperationsManifestError({
        code: "OBS_CLI_SOURCE_INVALID",
        message: `Query group ${invalidGroup.field} is not a declared source attribute.`,
        issues: [`undeclared query group ${invalidGroup.field}`],
        cause: invalidGroup.field,
      });
    }
    if (sources[0]?.kind === "metric" && stage.aggregation.kind !== "count") {
      const metrics = contract.metrics.filter((entry) => expandedSourceNames.includes(entry.name));
      const aggregatesValue =
        (stage.aggregation.kind === "field" || stage.aggregation.kind === "quantile") &&
        stage.aggregation.field === "value";
      const legal =
        metrics.length > 0 &&
        metrics.every(
          (metric) =>
            aggregatesValue &&
            ((metric.kind === "counter" &&
              stage.aggregation.kind === "field" &&
              stage.aggregation.function === "sum") ||
              (metric.kind === "histogram" &&
                (stage.aggregation.kind === "quantile" ||
                  (stage.aggregation.kind === "field" && stage.aggregation.function === "avg"))) ||
              (metric.kind === "observable_gauge" && stage.aggregation.kind === "field")),
        );
      if (!legal) {
        return yield* new OperationsManifestError({
          code: "OBS_CLI_SOURCE_INVALID",
          message: `Aggregation is not legal for every target of metric ${sources[0]?.name ?? "unknown"}.`,
          issues: ["illegal metric aggregation"],
          cause: metrics.map((metric) => metric.kind).join(","),
        });
      }
    }
  }
  return query;
});

export const validateOperationsManifest = Effect.fn("validateOperationsManifest")(function* (
  manifest: OperationsManifest,
  contract: OperationsContractIndex,
): Effect.fn.Return<ValidatedOperationsManifest, OperationsManifestError | ManagedQueryError> {
  if (
    manifest.service !== contract.service ||
    manifest.contractVersion !== contract.contractVersion
  ) {
    return yield* new OperationsManifestError({
      code: "OBS_CLI_CONTRACT_INDEX_STALE",
      message: "The contract index service or version does not match the operations manifest.",
      issues: ["service or contractVersion mismatch"],
      cause: contract.contractVersion,
    });
  }
  const issues: Array<string> = [];
  for (const environment of duplicates(manifest.environments))
    issues.push(`duplicate environment ${environment}`);
  for (const dashboard of duplicates(manifest.dashboards.map((entry) => entry.id)))
    issues.push(`duplicate dashboard ${dashboard}`);
  for (const monitor of duplicates(manifest.monitors.map((entry) => entry.id)))
    issues.push(`duplicate monitor ${monitor}`);
  for (const dashboard of manifest.dashboards) {
    for (const panel of duplicates(dashboard.panels.map((entry) => entry.id))) {
      issues.push(`duplicate panel ${dashboard.id}/${panel}`);
    }
  }
  const environments = new Set(manifest.environments);
  for (const retention of manifest.retention) {
    if (!environments.has(retention.environment))
      issues.push(`unknown retention environment ${retention.environment}`);
  }
  for (const environment of manifest.environments) {
    const matches = manifest.retention.filter((retention) => retention.environment === environment);
    if (matches.length !== 1)
      issues.push(`environment ${environment} requires exactly one retention`);
  }
  const eventsByName = new Map(contract.events.map((event) => [event.name, event]));
  const metricsByName = new Map(contract.metrics.map((metric) => [metric.name, metric]));
  const eventNames = new Set(eventsByName.keys());
  const metricNames = new Set(metricsByName.keys());
  for (const event of contract.events) {
    const attributes = [...event.attributes].sort();
    const classifications = event.attributeClassifications
      .map((attribute) => attribute.name)
      .sort();
    if (
      duplicates(event.attributes).length > 0 ||
      duplicates(classifications).length > 0 ||
      attributes.join("\u0000") !== classifications.join("\u0000")
    ) {
      issues.push(`inconsistent event attributes event ${event.name}`);
    }
  }
  for (const metric of contract.metrics) {
    if (duplicates(metric.attributes).length > 0) {
      issues.push(`duplicate metric attributes metric ${metric.name}`);
    }
  }
  const aliasGraph = buildAliasGraph(contract.aliases);
  for (const alias of contract.aliases) {
    const names = alias.kind === "event" ? eventNames : metricNames;
    if (!names.has(alias.to)) issues.push(`unknown alias target ${alias.kind} ${alias.to}`);
    if (aliasGraph.expand(alias.kind, alias.from).cyclic) {
      issues.push(`cyclic alias ${alias.kind} ${alias.from}`);
    }
  }
  const eventAliasSources = new Set(
    contract.aliases.filter((alias) => alias.kind === "event").map((alias) => alias.from),
  );
  for (const source of eventAliasSources) {
    const names = aliasGraph.expand("event", source).targets;
    const targets = [...names].flatMap((name) => {
      const event = eventsByName.get(name);
      return event === undefined ? [] : [event];
    });
    const first = targets[0];
    const signature = (event: (typeof targets)[number]): string =>
      [...event.attributeClassifications]
        .map((attribute) => `${attribute.name}\u0000${attribute.classification}`)
        .sort()
        .join("\u0001");
    if (
      first !== undefined &&
      targets.some(
        (target) =>
          [...target.attributes].sort().join("\u0000") !==
            [...first.attributes].sort().join("\u0000") || signature(target) !== signature(first),
      )
    ) {
      issues.push(`incompatible event alias targets event ${source}`);
    }
  }
  const metricAliasSources = new Set(
    contract.aliases.filter((alias) => alias.kind === "metric").map((alias) => alias.from),
  );
  for (const source of metricAliasSources) {
    const names = aliasGraph.expand("metric", source).targets;
    const targets = [...names].flatMap((name) => {
      const metric = metricsByName.get(name);
      return metric === undefined ? [] : [metric];
    });
    const first = targets[0];
    if (
      first !== undefined &&
      targets.some(
        (target) =>
          target.kind !== first.kind ||
          target.unit !== first.unit ||
          [...target.attributes].sort().join("\u0000") !==
            [...first.attributes].sort().join("\u0000"),
      )
    ) {
      issues.push(`incompatible metric alias targets metric ${source}`);
    }
  }
  const references = [
    ...manifest.dashboards.flatMap((dashboard) =>
      dashboard.panels.flatMap((panel) => panel.sources),
    ),
    ...manifest.monitors.map((monitor) => monitor.source),
  ];
  for (const reference of references) {
    const names = reference.kind === "event" ? eventNames : metricNames;
    const aliased = contract.aliases.some(
      (alias) =>
        alias.kind === reference.kind && alias.from === reference.name && names.has(alias.to),
    );
    if (!names.has(reference.name) && !aliased)
      issues.push(`unknown ${reference.kind} ${reference.name}`);
  }
  if (issues.length > 0) return yield* manifestInvalid(issues, issues.join(";"));
  const dashboards: Array<ValidatedDashboard> = [];
  for (const dashboard of manifest.dashboards) {
    const panels: Array<ValidatedPanel> = [];
    for (const panel of dashboard.panels) {
      panels.push({
        definition: panel,
        query: yield* validateQuery(panel.query, panel.sources, contract, aliasGraph),
      });
    }
    dashboards.push({ definition: dashboard, panels });
  }
  const monitors: Array<ValidatedMonitor> = [];
  for (const monitor of manifest.monitors) {
    monitors.push({
      definition: monitor,
      query: yield* validateQuery(monitor.query, [monitor.source], contract, aliasGraph),
    });
  }
  return { manifest, contract, dashboards, monitors };
});

export { ManagedQueryError };
