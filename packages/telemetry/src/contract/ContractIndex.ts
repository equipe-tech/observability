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

export const maximumContractAliasCount = 4_096;
export const maximumContractAliasDepth = 128;
export const maximumContractAliasTargets = 256;

export class ContractIndexAliasError extends Error {
  override readonly name = "ContractIndexAliasError";

  constructor(
    readonly code:
      | "OBS_CONTRACT_ALIAS_COUNT_EXCEEDED"
      | "OBS_CONTRACT_ALIAS_DEPTH_EXCEEDED"
      | "OBS_CONTRACT_ALIAS_TARGETS_EXCEEDED"
      | "OBS_CONTRACT_ALIAS_CYCLE",
    message: string,
  ) {
    super(message);
  }
}

const byName = <Entry extends { readonly name: string }>(left: Entry, right: Entry): number =>
  left.name.localeCompare(right.name);

const signalNamePattern = /^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$/;

type AliasGraph = {
  expand(kind: ContractSignalAlias["kind"], source: string): ReadonlySet<string>;
};

const aliasKey = (kind: ContractSignalAlias["kind"], name: string): string =>
  `${kind}\u0000${name}`;

const buildAliasGraph = (aliases: ReadonlyArray<ContractSignalAlias>): AliasGraph => {
  if (aliases.length > maximumContractAliasCount) {
    throw new ContractIndexAliasError(
      "OBS_CONTRACT_ALIAS_COUNT_EXCEEDED",
      `Contract aliases exceed the maximum count of ${maximumContractAliasCount}.`,
    );
  }
  const adjacency = new Map<string, Set<string>>();
  for (const alias of aliases) {
    const key = aliasKey(alias.kind, alias.from);
    const targets = adjacency.get(key) ?? new Set<string>();
    targets.add(alias.to);
    adjacency.set(key, targets);
  }
  const colors = new Map<string, "gray" | "black">();
  const depths = new Map<string, number>();
  const depth = (kind: ContractSignalAlias["kind"], source: string, traversed: number): number => {
    if (traversed > maximumContractAliasDepth) {
      throw new ContractIndexAliasError(
        "OBS_CONTRACT_ALIAS_DEPTH_EXCEEDED",
        `Contract alias depth exceeds the maximum of ${maximumContractAliasDepth}.`,
      );
    }
    const key = aliasKey(kind, source);
    const cached = depths.get(key);
    if (cached !== undefined) return cached;
    if (colors.get(key) === "gray") {
      throw new ContractIndexAliasError(
        "OBS_CONTRACT_ALIAS_CYCLE",
        "Contract aliases contain a cycle.",
      );
    }
    colors.set(key, "gray");
    let value = 0;
    for (const target of adjacency.get(key) ?? []) {
      value = Math.max(value, 1 + depth(kind, target, traversed + 1));
      if (value > maximumContractAliasDepth) {
        throw new ContractIndexAliasError(
          "OBS_CONTRACT_ALIAS_DEPTH_EXCEEDED",
          `Contract alias depth exceeds the maximum of ${maximumContractAliasDepth}.`,
        );
      }
    }
    colors.set(key, "black");
    depths.set(key, value);
    return value;
  };
  for (const alias of aliases) depth(alias.kind, alias.from, 0);

  const expansions = new Map<string, ReadonlySet<string>>();
  const expand = (kind: ContractSignalAlias["kind"], source: string): ReadonlySet<string> => {
    const key = aliasKey(kind, source);
    const cached = expansions.get(key);
    if (cached !== undefined) return cached;
    const targets = new Set([source]);
    for (const target of adjacency.get(key) ?? []) {
      for (const nestedTarget of expand(kind, target)) {
        targets.add(nestedTarget);
        if (targets.size > maximumContractAliasTargets) {
          throw new ContractIndexAliasError(
            "OBS_CONTRACT_ALIAS_TARGETS_EXCEEDED",
            `Contract alias expansion exceeds the maximum of ${maximumContractAliasTargets} targets.`,
          );
        }
      }
    }
    expansions.set(key, targets);
    return targets;
  };
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
  if (metadata.aliases.length > maximumContractAliasCount) {
    throw new ContractIndexAliasError(
      "OBS_CONTRACT_ALIAS_COUNT_EXCEEDED",
      `Contract aliases exceed the maximum count of ${maximumContractAliasCount}.`,
    );
  }
  const aliases = metadata.aliases.map((alias) => {
    if (alias.source.kind !== alias.target.kind) {
      throw new TypeError("Contract alias source and target kinds must match.");
    }
    if (!signalNamePattern.test(alias.source.name) || !signalNamePattern.test(alias.target.name)) {
      throw new TypeError("Contract alias names must use the telemetry signal grammar.");
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
  for (const alias of aliases) aliasGraph.expand(alias.kind, alias.from);
  for (const alias of aliases) {
    const targetExists = alias.kind === "event" ? events.has(alias.to) : metrics.has(alias.to);
    if (!targetExists) {
      throw new TypeError(`Contract alias target ${alias.to} is not declared.`);
    }
  }
  const metricSources = new Set(
    aliases.filter((alias) => alias.kind === "metric").map((alias) => alias.from),
  );
  for (const source of metricSources) {
    const names = aliasGraph.expand("metric", source);
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
    const names = aliasGraph.expand("event", source);
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
