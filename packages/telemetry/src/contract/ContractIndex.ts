import type {
  AttributeClassification,
  TelemetryContract,
  TelemetryContractInput,
} from "./TelemetryContract.ts";
import type { EventKind } from "./TelemetryEvent.ts";
import type { MetricKind } from "./MetricDefinition.ts";

export type ContractIndexEventAttribute = {
  readonly name: string;
  readonly classification: AttributeClassification;
};

export type ContractIndexEvent = {
  readonly name: string;
  readonly kind: EventKind;
  readonly attributes: ReadonlyArray<string>;
  readonly attributeClassifications: ReadonlyArray<ContractIndexEventAttribute>;
};

export type ContractIndexMetric = {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly attributes: ReadonlyArray<string>;
};

export type ContractSignalReference = {
  readonly kind: "event" | "metric";
  readonly name: string;
};

export type ContractSignalAliasDefinition = {
  readonly source: ContractSignalReference;
  readonly target: ContractSignalReference;
};

export type ContractSignalAliasMetadata = {
  readonly version: 1;
  readonly aliases: ReadonlyArray<ContractSignalAliasDefinition>;
};

export type ContractSignalAlias = {
  readonly kind: "event" | "metric";
  readonly from: string;
  readonly to: string;
};

export type ContractIndex = {
  readonly index: 1;
  readonly contractVersion: number;
  readonly service: string;
  readonly events: ReadonlyArray<ContractIndexEvent>;
  readonly metrics: ReadonlyArray<ContractIndexMetric>;
  readonly aliases: ReadonlyArray<ContractSignalAlias>;
};

const byName = <Entry extends { readonly name: string }>(left: Entry, right: Entry): number =>
  left.name.localeCompare(right.name);

const signalNamePattern = /^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$/;

type AliasExpansion = {
  readonly targets: ReadonlySet<string>;
  readonly cyclic: boolean;
};
type AliasGraph = {
  expand(kind: ContractSignalAlias["kind"], source: string): AliasExpansion;
};

const aliasKey = (kind: ContractSignalAlias["kind"], name: string): string =>
  `${kind}\u0000${name}`;

const buildAliasGraph = (aliases: ReadonlyArray<ContractSignalAlias>): AliasGraph => {
  const adjacency = new Map<string, Set<string>>();
  for (const alias of aliases) {
    const key = aliasKey(alias.kind, alias.from);
    const targets = adjacency.get(key) ?? new Set<string>();
    targets.add(alias.to);
    adjacency.set(key, targets);
  }
  const colors = new Map<string, "gray" | "black">();
  const expansions = new Map<string, AliasExpansion>();
  const expand = (kind: ContractSignalAlias["kind"], source: string): AliasExpansion => {
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

const validatedAliases = <Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  metadata: ContractSignalAliasMetadata,
): ReadonlyArray<ContractSignalAlias> => {
  const eventEntries = [...contract.eventByName.values()];
  const metricEntries = [...contract.metricByName.values()];
  const events = new Map<string, (typeof eventEntries)[number]>();
  const metrics = new Map<string, (typeof metricEntries)[number]>();
  for (const event of eventEntries) events.set(event.name, event);
  for (const metric of metricEntries) metrics.set(metric.name, metric);
  const aliases = metadata.aliases.map((alias) => {
    if (alias.source.kind !== alias.target.kind) {
      throw new TypeError("Contract alias source and target kinds must match.");
    }
    if (!signalNamePattern.test(alias.source.name) || !signalNamePattern.test(alias.target.name)) {
      throw new TypeError("Contract alias names must use the telemetry signal grammar.");
    }
    const targetExists =
      alias.target.kind === "event"
        ? events.has(alias.target.name)
        : metrics.has(alias.target.name);
    if (!targetExists) {
      throw new TypeError(`Contract alias target ${alias.target.name} is not declared.`);
    }
    if (alias.source.name === alias.target.name) {
      throw new TypeError("Contract alias source and target must differ.");
    }
    return {
      kind: alias.source.kind,
      from: alias.source.name,
      to: alias.target.name,
    };
  });
  const aliasGraph = buildAliasGraph(aliases);
  for (const alias of aliases) {
    if (aliasGraph.expand(alias.kind, alias.from).cyclic) {
      throw new TypeError("Contract aliases contain a cycle.");
    }
  }
  const metricSources = new Set(
    aliases.filter((alias) => alias.kind === "metric").map((alias) => alias.from),
  );
  for (const source of metricSources) {
    const names = aliasGraph.expand("metric", source).targets;
    const targets = [...names].flatMap((name) => {
      const metric = metrics.get(name);
      return metric === undefined ? [] : [metric];
    });
    const first = targets[0];
    if (
      first !== undefined &&
      targets.some(
        (target) =>
          target.kind !== first.kind ||
          target.unit !== first.unit ||
          [...target.attributes.keys()].sort().join("\u0000") !==
            [...first.attributes.keys()].sort().join("\u0000"),
      )
    ) {
      throw new TypeError(
        `Contract metric alias source ${source} targets incompatible kind, unit, or attributes.`,
      );
    }
  }
  const eventSources = new Set(
    aliases.filter((alias) => alias.kind === "event").map((alias) => alias.from),
  );
  for (const source of eventSources) {
    const names = aliasGraph.expand("event", source).targets;
    const targets = [...names].flatMap((name) => {
      const event = events.get(name);
      return event === undefined ? [] : [event];
    });
    const first = targets[0];
    const signature = (event: (typeof targets)[number]): string =>
      [...event.attributes.entries()]
        .map(([name, attribute]) => `${name}\u0000${attribute.classification}`)
        .sort()
        .join("\u0001");
    if (first !== undefined && targets.some((target) => signature(target) !== signature(first))) {
      throw new TypeError(
        `Contract event alias source ${source} targets incompatible attributes or classifications.`,
      );
    }
  }
  return aliases.sort((left, right) =>
    `${left.kind}\u0000${left.from}\u0000${left.to}`.localeCompare(
      `${right.kind}\u0000${right.from}\u0000${right.to}`,
    ),
  );
};

export const contractIndex = <Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  service: string,
  aliasMetadata: ContractSignalAliasMetadata = { version: 1, aliases: [] },
): ContractIndex => ({
  index: 1,
  contractVersion: contract.version,
  service,
  events: [...contract.eventByName.values()]
    .map((event) => ({
      name: event.name,
      kind: event.kind,
      attributes: [...event.attributes.keys()].sort(),
      attributeClassifications: [...event.attributes.entries()]
        .map(([name, attribute]) => ({ name, classification: attribute.classification }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort(byName),
  metrics: [...contract.metricByName.values()]
    .map((metric) => ({
      name: metric.name,
      kind: metric.kind,
      unit: metric.unit,
      attributes: [...metric.attributes.keys()].sort(),
    }))
    .sort(byName),
  aliases: validatedAliases(contract, aliasMetadata),
});

export const encodeContractIndex = (index: ContractIndex): string =>
  `${JSON.stringify(index, null, 2)}\n`;
