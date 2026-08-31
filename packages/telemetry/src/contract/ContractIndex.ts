import type { TelemetryContract, TelemetryContractInput } from "./TelemetryContract.ts";
import type { EventKind } from "./TelemetryEvent.ts";
import type { MetricKind } from "./MetricDefinition.ts";

export type ContractIndexEvent = {
  readonly name: string;
  readonly kind: EventKind;
  readonly attributes: ReadonlyArray<string>;
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

const validatedAliases = <Definition extends TelemetryContractInput>(
  contract: TelemetryContract<Definition>,
  metadata: ContractSignalAliasMetadata,
): ReadonlyArray<ContractSignalAlias> => {
  const aliases = metadata.aliases.map((alias) => {
    if (alias.source.kind !== alias.target.kind) {
      throw new TypeError("Contract alias source and target kinds must match.");
    }
    if (!signalNamePattern.test(alias.source.name) || !signalNamePattern.test(alias.target.name)) {
      throw new TypeError("Contract alias names must use the telemetry signal grammar.");
    }
    const targetExists =
      alias.target.kind === "event"
        ? [...contract.eventByName.values()].some((event) => event.name === alias.target.name)
        : [...contract.metricByName.values()].some((metric) => metric.name === alias.target.name);
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
  for (const alias of aliases) {
    const paths: Array<ReadonlyArray<string>> = [[alias.from]];
    for (let cursor = 0; cursor < paths.length; cursor += 1) {
      const path = paths[cursor];
      const target = path?.at(-1);
      if (path === undefined || target === undefined) continue;
      for (const next of aliases.filter(
        (candidate) => candidate.kind === alias.kind && candidate.from === target,
      )) {
        if (path.includes(next.to)) throw new TypeError("Contract aliases contain a cycle.");
        paths.push([...path, next.to]);
      }
    }
  }
  const metricSources = new Set(
    aliases.filter((alias) => alias.kind === "metric").map((alias) => alias.from),
  );
  for (const source of metricSources) {
    const targets = aliases
      .filter((alias) => alias.kind === "metric" && alias.from === source)
      .map((alias) =>
        [...contract.metricByName.values()].find((metric) => metric.name === alias.to),
      )
      .filter((metric) => metric !== undefined);
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
