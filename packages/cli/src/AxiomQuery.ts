import { Effect } from "effect";
import {
  ManagedQueryError,
  quoteAplString,
  type ManagedQuery,
  type ManagedQueryAggregation,
  type ManagedQueryComparison,
  type ManagedQueryGroup,
  type ManagedQueryLiteral,
  type ManagedQueryStage,
} from "./ManagedQuery.ts";

export type AxiomMetricKind = "counter" | "histogram" | "observable_gauge";

export type AxiomQueryTarget =
  | {
      readonly language: "apl";
      readonly dataset: string;
      readonly signals: readonly [string, ...ReadonlyArray<string>];
    }
  | {
      readonly language: "mpl";
      readonly dataset: string;
      readonly signals: readonly [string, ...ReadonlyArray<string>];
      readonly metricKind: AxiomMetricKind;
    };

export type AxiomQuery = {
  readonly language: "apl" | "mpl";
  readonly dataset: string;
  readonly text: string;
};

const maximumAxiomQueryLength = 16_384;
const resourceFields = new Map([
  ["service.name", "service.name"],
  ["service.namespace", "service.namespace"],
  ["service.version", "service.version"],
  ["deployment.environment.name", "resource.deployment.environment.name"],
]);
const timeFields = new Set(["timestamp", "event.timestamp"]);

const unsupported = (message: string, cause: unknown): ManagedQueryError =>
  new ManagedQueryError({ code: "OBS_CLI_QUERY_INVALID", message, cause });

const aplField = (field: string): string => {
  if (timeFields.has(field)) return "_time";
  return `[${quoteAplString(resourceFields.get(field) ?? `attributes.${field}`)}]`;
};

const aplLiteral = (literal: ManagedQueryLiteral): string => {
  if (literal.kind === "string") return quoteAplString(literal.value);
  if (literal.kind === "boolean") return literal.value ? "true" : "false";
  return String(literal.value);
};

const aplComparison = (
  comparison: ManagedQueryComparison,
  query: ManagedQuery,
  target: AxiomQueryTarget,
): string => {
  const field = aplField(comparison.field);
  if (comparison.field === query.binding.field) {
    return target.signals.length === 1
      ? `${field} == ${quoteAplString(target.signals[0])}`
      : `${field} in (${target.signals.map(quoteAplString).join(", ")})`;
  }
  if (comparison.operator === "in") {
    return `${field} in (${comparison.values.map(aplLiteral).join(", ")})`;
  }
  return `${field} ${comparison.operator} ${comparison.values.map(aplLiteral).join("")}`;
};

const aplAggregation = (aggregation: ManagedQueryAggregation): string => {
  if (aggregation.kind === "count") return "count()";
  if (aggregation.kind === "quantile") {
    return `percentile(${aplField(aggregation.field)}, ${aggregation.percentile})`;
  }
  return `${aggregation.function}(${aplField(aggregation.field)})`;
};

const aplGroup = Effect.fn("aplGroup")(function* (group: ManagedQueryGroup) {
  if (group.kind === "field") return aplField(group.field);
  if (!timeFields.has(group.field)) {
    return yield* unsupported(
      `Axiom queries can only bin the event time, not ${group.field}.`,
      group.field,
    );
  }
  return `bin(_time, ${group.duration})`;
});

const compileApl = Effect.fn("compileApl")(function* (
  query: ManagedQuery,
  target: AxiomQueryTarget,
) {
  if (query.stream !== "logs") {
    return yield* unsupported(
      "Axiom dashboards and monitors read events from signal(logs).",
      query.stream,
    );
  }
  const stages: Array<string> = [];
  for (const stage of query.stages) {
    if (stage.kind === "where") {
      stages.push(
        `where ${stage.comparisons.map((comparison) => aplComparison(comparison, query, target)).join(" and ")}`,
      );
      continue;
    }
    const groups: Array<string> = [];
    for (const group of stage.groups) groups.push(yield* aplGroup(group));
    const suffix = groups.length === 0 ? "" : ` by ${groups.join(", ")}`;
    stages.push(`summarize ${aplAggregation(stage.aggregation)}${suffix}`);
  }
  return [`[${quoteAplString(target.dataset)}]`, ...stages].join("\n| ");
});

const mplIdentifier = (identifier: string): string => `\`${identifier}\``;

const mplLiteral = (literal: ManagedQueryLiteral): string => {
  if (literal.kind === "string") return JSON.stringify(literal.value);
  if (literal.kind === "boolean") return literal.value ? "true" : "false";
  return String(literal.value);
};

const mplComparison = (comparison: ManagedQueryComparison): string => {
  const field = mplIdentifier(comparison.field);
  if (comparison.operator === "in") {
    const alternatives = comparison.values.map((value) => `${field} == ${mplLiteral(value)}`);
    return alternatives.length === 1 ? (alternatives[0] ?? "") : `(${alternatives.join(" or ")})`;
  }
  return `${field} ${comparison.operator} ${comparison.values.map(mplLiteral).join("")}`;
};

export const fractionFromPercentile = (percentile: string): string => {
  const [integer = "0", fraction = ""] = percentile.split(".");
  const padded = integer.padStart(3, "0");
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, "");
  const decimals = `${padded.slice(-2)}${fraction}`.replace(/0+$/, "");
  return decimals.length === 0 ? whole : `${whole}.${decimals}`;
};

const mplTransformation = Effect.fn("mplTransformation")(function* (
  aggregation: ManagedQueryAggregation,
  metricKind: AxiomMetricKind,
  groups: string,
) {
  if (metricKind === "counter" && aggregation.kind === "field" && aggregation.function === "sum") {
    return ["| map increase", "| align using sum", `| group${groups} using sum`];
  }
  if (metricKind === "histogram" && aggregation.kind === "quantile") {
    return [
      `| bucket${groups} using interpolate_cumulative_histogram(rate, ${fractionFromPercentile(aggregation.percentile)})`,
    ];
  }
  if (metricKind === "observable_gauge" && aggregation.kind === "field") {
    return [
      `| align using ${aggregation.function}`,
      `| group${groups} using ${aggregation.function}`,
    ];
  }
  return yield* unsupported(
    `Axiom MPL does not support ${aggregation.kind} aggregation for ${metricKind} metrics.`,
    metricKind,
  );
});

const compileMpl = Effect.fn("compileMpl")(function* (
  query: ManagedQuery,
  target: Extract<AxiomQueryTarget, { readonly language: "mpl" }>,
) {
  if (target.signals.length !== 1) {
    return yield* unsupported(
      "Axiom MPL queries read exactly one metric. Remove the metric alias expansion.",
      target.signals.join(","),
    );
  }
  const summarize = query.stages.at(-1);
  const filters = query.stages.slice(0, -1);
  if (
    summarize === undefined ||
    summarize.kind !== "summarize" ||
    filters.some((stage) => stage.kind !== "where")
  ) {
    return yield* unsupported(
      "Axiom MPL queries require where stages followed by one final summarize stage.",
      query.stages.length,
    );
  }
  const comparisons = filters.flatMap((stage: ManagedQueryStage) =>
    stage.kind === "where"
      ? stage.comparisons.filter((comparison) => comparison.field !== query.binding.field)
      : [],
  );
  const binnedField = summarize.groups.find(
    (group) => group.kind === "bin" && !timeFields.has(group.field),
  );
  if (binnedField !== undefined) {
    return yield* unsupported(
      `Axiom queries can only bin the event time, not ${binnedField.field}.`,
      binnedField.field,
    );
  }
  const groupFields = summarize.groups
    .filter((group) => group.kind === "field")
    .map((group) => mplIdentifier(group.field));
  const groups = groupFields.length === 0 ? "" : ` by ${groupFields.join(", ")}`;
  const lines = [`${mplIdentifier(target.dataset)}:${mplIdentifier(target.signals[0])}`];
  if (comparisons.length > 0) {
    lines.push(`| where ${comparisons.map(mplComparison).join(" and ")}`);
  }
  lines.push(...(yield* mplTransformation(summarize.aggregation, target.metricKind, groups)));
  return lines.join("\n");
});

export const compileAxiomQuery = Effect.fn("compileAxiomQuery")(function* (
  query: ManagedQuery,
  target: AxiomQueryTarget,
): Effect.fn.Return<AxiomQuery, ManagedQueryError> {
  const text =
    target.language === "apl" ? yield* compileApl(query, target) : yield* compileMpl(query, target);
  if (text.length > maximumAxiomQueryLength) {
    return yield* unsupported(
      `The compiled Axiom query exceeds ${maximumAxiomQueryLength} characters.`,
      text.length,
    );
  }
  return { language: target.language, dataset: target.dataset, text };
});
