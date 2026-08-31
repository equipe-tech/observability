import { Effect, Schema } from "effect";

export const ManagedSignalStream = Schema.Literals(["logs", "traces", "metrics"]);
export type ManagedSignalStream = typeof ManagedSignalStream.Type;

export type ManagedQueryLiteral =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean };

export type ManagedQueryComparison = {
  readonly kind: "comparison";
  readonly field: string;
  readonly operator: "==" | "!=" | ">" | ">=" | "<" | "<=" | "in";
  readonly values: ReadonlyArray<ManagedQueryLiteral>;
};

export type ManagedQueryAggregation =
  | { readonly kind: "count" }
  | {
      readonly kind: "field";
      readonly function: "sum" | "avg" | "min" | "max";
      readonly field: string;
    }
  | { readonly kind: "quantile"; readonly field: string; readonly percentile: string };

export type ManagedQueryGroup =
  | { readonly kind: "field"; readonly field: string }
  | { readonly kind: "bin"; readonly field: string; readonly duration: string };

export type ManagedQueryStage =
  | { readonly kind: "where"; readonly comparisons: ReadonlyArray<ManagedQueryComparison> }
  | {
      readonly kind: "summarize";
      readonly aggregation: ManagedQueryAggregation;
      readonly groups: ReadonlyArray<ManagedQueryGroup>;
    };

export type ManagedQuery = {
  readonly stream: ManagedSignalStream;
  readonly stages: ReadonlyArray<ManagedQueryStage>;
  readonly binding: {
    readonly field: "event.name" | "metric.name";
    readonly identifiers: ReadonlyArray<string>;
  };
};

export type ManagedQueryTarget = {
  readonly dataset: string;
  readonly language: "apl" | "mpl";
  readonly signals: readonly [string, ...ReadonlyArray<string>];
};

export type CompiledManagedQuery = {
  readonly dataset: string;
  readonly language: "apl" | "mpl";
  readonly text: string;
};

export class ManagedQueryError extends Schema.TaggedError<ManagedQueryError>()(
  "ManagedQueryError",
  {
    code: Schema.Literals([
      "OBS_CLI_QUERY_INVALID",
      "OBS_CLI_QUERY_SIGNAL_UNBOUND",
      "OBS_CLI_QUERY_SIGNAL_AMBIGUOUS",
      "OBS_CLI_QUERY_SIGNAL_MISMATCH",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const invalidQuery = (message: string, cause: string): ManagedQueryError =>
  new ManagedQueryError({ code: "OBS_CLI_QUERY_INVALID", message, cause });

const fieldPattern = /^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)*$/;
const durationPattern = /^[1-9][0-9]*(?:ms|s|m|h|d)$/;
const numberPattern = /^-?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$/;
const percentilePattern = /^(?:100(?:[.]0+)?|(?:0|[1-9][0-9]?)(?:[.][0-9]+)?)$/;
const safeManagedQueryNumber = (value: number): boolean =>
  Number.isFinite(value) &&
  Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
  !String(value).toLowerCase().includes("e");
const SafeManagedQueryNumber = Schema.Number.check(
  Schema.makeFilter(safeManagedQueryNumber, {
    expected: "a finite, non-exponential number within JavaScript's safe magnitude",
  }),
);
const ManagedQueryLiteralInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("number"), value: SafeManagedQueryNumber }),
  Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean }),
]);
const ManagedQueryScalarComparisonInput = Schema.Struct({
  kind: Schema.Literal("comparison"),
  field: Schema.String.check(Schema.isPattern(fieldPattern)),
  operator: Schema.Literals(["==", "!=", ">", ">=", "<", "<="]),
  values: Schema.Array(ManagedQueryLiteralInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
});
const ManagedQuerySetComparisonInput = Schema.Struct({
  kind: Schema.Literal("comparison"),
  field: Schema.String.check(Schema.isPattern(fieldPattern)),
  operator: Schema.Literal("in"),
  values: Schema.Array(ManagedQueryLiteralInput).check(Schema.isMinLength(1)),
});
const ManagedQueryAggregationInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("count") }),
  Schema.Struct({
    kind: Schema.Literal("field"),
    function: Schema.Literals(["sum", "avg", "min", "max"]),
    field: Schema.String.check(Schema.isPattern(fieldPattern)),
  }),
  Schema.Struct({
    kind: Schema.Literal("quantile"),
    field: Schema.String.check(Schema.isPattern(fieldPattern)),
    percentile: Schema.String.check(Schema.isPattern(percentilePattern)),
  }),
]);
const ManagedQueryGroupInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("field"),
    field: Schema.String.check(Schema.isPattern(fieldPattern)),
  }),
  Schema.Struct({
    kind: Schema.Literal("bin"),
    field: Schema.String.check(Schema.isPattern(fieldPattern)),
    duration: Schema.String.check(Schema.isPattern(durationPattern)),
  }),
]);
const ManagedQueryStageInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("where"),
    comparisons: Schema.Array(
      Schema.Union([ManagedQueryScalarComparisonInput, ManagedQuerySetComparisonInput]),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("summarize"),
    aggregation: ManagedQueryAggregationInput,
    groups: Schema.Array(ManagedQueryGroupInput),
  }),
]);
const ManagedQueryCompilationInput = Schema.Struct({
  query: Schema.Struct({
    stream: ManagedSignalStream,
    stages: Schema.Array(ManagedQueryStageInput),
    binding: Schema.Struct({
      field: Schema.Literals(["event.name", "metric.name"]),
      identifiers: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
    }),
  }),
  target: Schema.Struct({
    dataset: Schema.NonEmptyString,
    language: Schema.Literals(["apl", "mpl"]),
    signals: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  }),
});
const decodeManagedQueryCompilationInput = Schema.decodeUnknownEffect(
  ManagedQueryCompilationInput,
  {
    onExcessProperty: "error",
  },
);

const splitOutsideStrings = (
  input: string,
  separator: string,
): ReadonlyArray<string> | ManagedQueryError => {
  const parts: Array<string> = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && input.startsWith(separator, index)) {
      parts.push(input.slice(start, index).trim());
      index += separator.length - 1;
      start = index + 1;
    }
    if (depth < 0) return invalidQuery("The managed query has an unmatched parenthesis.", input);
  }
  if (quoted || depth !== 0) {
    return invalidQuery("The managed query has an unterminated string or parenthesis.", input);
  }
  parts.push(input.slice(start).trim());
  return parts;
};

const decodeString = (input: string): string | ManagedQueryError => {
  if (!input.startsWith('"')) {
    return invalidQuery("Managed query strings must use double quotes.", input);
  }
  let value = "";
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;
    if (character === '"') {
      return input.slice(index + 1).trim().length === 0
        ? value
        : invalidQuery("Managed query strings cannot contain trailing predicate text.", input);
    }
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = input[index + 1];
    if (escaped !== '"' && escaped !== "\\") {
      return invalidQuery(
        "Managed query strings only support escaped quotes and backslashes.",
        input,
      );
    }
    value += escaped;
    index += 1;
  }
  return invalidQuery("Managed query strings must be terminated.", input);
};

const parseLiteral = (input: string): ManagedQueryLiteral | ManagedQueryError => {
  if (input.startsWith('"')) {
    const value = decodeString(input);
    return value instanceof ManagedQueryError ? value : { kind: "string", value };
  }
  if (input === "true" || input === "false") return { kind: "boolean", value: input === "true" };
  if (numberPattern.test(input)) {
    const value = Number(input);
    if (safeManagedQueryNumber(value)) return { kind: "number", value };
  }
  return invalidQuery("The managed query contains an unsupported literal.", input);
};

const parseComparison = (input: string): ManagedQueryComparison | ManagedQueryError => {
  const inMatch = /^([a-z][a-z0-9_.]*)\s+in\s*[(](.*)[)]$/.exec(input);
  if (inMatch !== null) {
    const field = inMatch[1];
    const body = inMatch[2];
    if (field === undefined || body === undefined || !fieldPattern.test(field)) {
      return invalidQuery("The managed query contains an invalid field.", input);
    }
    const entries = splitOutsideStrings(body, ",");
    if (entries instanceof ManagedQueryError || entries.length === 0) {
      return invalidQuery("The managed query contains an invalid in predicate.", input);
    }
    const values: Array<ManagedQueryLiteral> = [];
    for (const entry of entries) {
      const literal = parseLiteral(entry);
      if (literal instanceof ManagedQueryError) return literal;
      values.push(literal);
    }
    return { kind: "comparison", field, operator: "in", values };
  }
  const match = /^([a-z][a-z0-9_.]*)\s*(==|!=|>=|<=|>|<)\s*([\s\S]+)$/.exec(input);
  const field = match?.[1];
  const operator = match?.[2];
  const raw = match?.[3];
  if (
    field === undefined ||
    operator === undefined ||
    raw === undefined ||
    !fieldPattern.test(field) ||
    (operator !== "==" &&
      operator !== "!=" &&
      operator !== ">" &&
      operator !== ">=" &&
      operator !== "<" &&
      operator !== "<=")
  ) {
    return invalidQuery("The managed query contains an unsupported predicate.", input);
  }
  const literal = parseLiteral(raw.trim());
  if (literal instanceof ManagedQueryError) return literal;
  return { kind: "comparison", field, operator, values: [literal] };
};

const textOutsideStrings = (input: string): string => {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (const character of input) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      output += " ";
    } else if (character === '"') {
      quoted = true;
      output += " ";
    } else {
      output += character;
    }
  }
  return output;
};

const maximumBooleanSeparatorWhitespace = 32;
const splitBooleanAndOutsideStrings = (
  input: string,
): ReadonlyArray<string> | ManagedQueryError => {
  const parts: Array<string> = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth < 0) return invalidQuery("The managed query has an unmatched parenthesis.", input);
      continue;
    }
    if (depth !== 0 || !/\s/.test(character)) continue;
    const separatorStart = index;
    while (/\s/.test(input[index] ?? "")) index += 1;
    const leadingWhitespace = index - separatorStart;
    if (input.slice(index, index + 3).toLowerCase() !== "and") {
      index -= 1;
      continue;
    }
    const wordEnd = index + 3;
    if (!/\s/.test(input[wordEnd] ?? "")) {
      index -= 1;
      continue;
    }
    index = wordEnd;
    while (/\s/.test(input[index] ?? "")) index += 1;
    const trailingWhitespace = index - wordEnd;
    if (
      leadingWhitespace > maximumBooleanSeparatorWhitespace ||
      trailingWhitespace > maximumBooleanSeparatorWhitespace
    ) {
      index -= 1;
      continue;
    }
    parts.push(input.slice(start, separatorStart).trim());
    start = index;
    index -= 1;
  }
  if (quoted || depth !== 0) {
    return invalidQuery("The managed query has an unterminated string or parenthesis.", input);
  }
  parts.push(input.slice(start).trim());
  return parts;
};

const parseWhere = (input: string): ManagedQueryStage | ManagedQueryError => {
  if (/\bor\b/i.test(textOutsideStrings(input))) {
    return new ManagedQueryError({
      code: "OBS_CLI_QUERY_SIGNAL_AMBIGUOUS",
      message: "Managed queries do not allow ambiguous OR predicates.",
      cause: input,
    });
  }
  const parts = splitBooleanAndOutsideStrings(input);
  if (parts instanceof ManagedQueryError || parts.length === 0) {
    return invalidQuery("The managed query has an invalid where stage.", input);
  }
  const comparisons: Array<ManagedQueryComparison> = [];
  for (const part of parts) {
    const comparison = parseComparison(part);
    if (comparison instanceof ManagedQueryError) return comparison;
    comparisons.push(comparison);
  }
  return { kind: "where", comparisons };
};

const parseAggregation = (input: string): ManagedQueryAggregation | ManagedQueryError => {
  if (input === "count()") return { kind: "count" };
  const quantile = /^quantile[(]([a-z][a-z0-9_.]*),\s*(0(?:[.][0-9]+)?|1(?:[.]0+)?)\)$/.exec(input);
  if (quantile !== null) {
    const field = quantile[1];
    const value = quantile[2];
    if (field !== undefined && value !== undefined && fieldPattern.test(field)) {
      const [whole = "0", fraction = ""] = value.split(".");
      const digits = `${whole}${fraction.padEnd(2, "0")}`;
      const integer = digits.slice(0, whole.length + 2).replace(/^0+(?=\d)/, "");
      const remainder = digits.slice(whole.length + 2).replace(/0+$/, "");
      const percentile = remainder.length === 0 ? integer : `${integer}.${remainder}`;
      return { kind: "quantile", field, percentile };
    }
  }
  const fieldAggregation = /^(sum|avg|min|max)\(([a-z][a-z0-9_.]*)\)$/.exec(input);
  const fn = fieldAggregation?.[1];
  const field = fieldAggregation?.[2];
  if (
    field !== undefined &&
    (fn === "sum" || fn === "avg" || fn === "min" || fn === "max") &&
    fieldPattern.test(field)
  ) {
    return { kind: "field", function: fn, field };
  }
  return invalidQuery("The managed query contains an unsupported aggregation.", input);
};

const parseGroup = (input: string): ManagedQueryGroup | ManagedQueryError => {
  const bin = /^bin\(([a-z][a-z0-9_.]*),\s*([1-9][0-9]*(?:ms|s|m|h|d))\)$/.exec(input);
  if (bin !== null) {
    const field = bin[1];
    const duration = bin[2];
    if (
      field !== undefined &&
      duration !== undefined &&
      fieldPattern.test(field) &&
      durationPattern.test(duration)
    ) {
      return { kind: "bin", field, duration };
    }
  }
  if (fieldPattern.test(input)) return { kind: "field", field: input };
  return invalidQuery("The managed query contains an unsupported grouping.", input);
};

const parseSummarize = (input: string): ManagedQueryStage | ManagedQueryError => {
  const byParts = splitOutsideStrings(input, " by ");
  if (byParts instanceof ManagedQueryError || byParts.length > 2) {
    return invalidQuery("The managed query has an invalid summarize stage.", input);
  }
  const aggregationText = byParts[0];
  if (aggregationText === undefined) return invalidQuery("The summarize stage is empty.", input);
  const aggregation = parseAggregation(aggregationText);
  if (aggregation instanceof ManagedQueryError) return aggregation;
  const groups: Array<ManagedQueryGroup> = [];
  const groupText = byParts[1];
  if (groupText !== undefined) {
    const groupParts = splitOutsideStrings(groupText, ",");
    if (groupParts instanceof ManagedQueryError) return groupParts;
    for (const part of groupParts) {
      const group = parseGroup(part);
      if (group instanceof ManagedQueryError) return group;
      groups.push(group);
    }
  }
  return { kind: "summarize", aggregation, groups };
};

const parseManagedQuerySync = (text: string): ManagedQuery | ManagedQueryError => {
  const syntax = textOutsideStrings(text);
  if (
    text.length === 0 ||
    text.length > 16_384 ||
    text.includes("\u0000") ||
    /\/\/|\/\*|--/.test(syntax)
  ) {
    return invalidQuery("The managed query is empty, oversized, or contains comments.", "query");
  }
  const pipeline = splitOutsideStrings(text.trim(), "|");
  if (pipeline instanceof ManagedQueryError) return pipeline;
  const head = pipeline[0];
  const streamMatch = /^signal\((logs|traces|metrics)\)$/.exec(head ?? "");
  const stream = streamMatch?.[1];
  if (stream !== "logs" && stream !== "traces" && stream !== "metrics") {
    return invalidQuery(
      "The managed query must begin with signal(logs|traces|metrics).",
      head ?? "",
    );
  }
  const stages: Array<ManagedQueryStage> = [];
  for (const rawStage of pipeline.slice(1)) {
    let stage: ManagedQueryStage | ManagedQueryError;
    if (rawStage.startsWith("where ")) stage = parseWhere(rawStage.slice(6).trim());
    else if (rawStage.startsWith("summarize ")) stage = parseSummarize(rawStage.slice(10).trim());
    else return invalidQuery("The managed query contains an unsupported stage.", rawStage);
    if (stage instanceof ManagedQueryError) return stage;
    stages.push(stage);
  }
  const bindingField = stream === "metrics" ? "metric.name" : "event.name";
  const bindings = stages.flatMap((stage) =>
    stage.kind === "where"
      ? stage.comparisons.filter((comparison) => comparison.field === bindingField)
      : [],
  );
  if (bindings.length === 0) {
    return new ManagedQueryError({
      code: "OBS_CLI_QUERY_SIGNAL_UNBOUND",
      message: `The managed query must bind ${bindingField} exactly once.`,
      cause: bindingField,
    });
  }
  const binding = bindings[0];
  if (
    bindings.length !== 1 ||
    binding === undefined ||
    (binding.operator !== "==" && binding.operator !== "in") ||
    binding.values.length === 0 ||
    binding.values.some((value) => value.kind !== "string")
  ) {
    return new ManagedQueryError({
      code: "OBS_CLI_QUERY_SIGNAL_AMBIGUOUS",
      message: `The managed query must bind ${bindingField} to one exact string predicate.`,
      cause: bindingField,
    });
  }
  const identifiers = binding.values.flatMap((value) =>
    value.kind === "string" ? [value.value] : [],
  );
  return { stream, stages, binding: { field: bindingField, identifiers } };
};

export const parseManagedQuery = Effect.fn("parseManagedQuery")(function* (
  text: string,
): Effect.fn.Return<ManagedQuery, ManagedQueryError> {
  const result = yield* Effect.try({
    try: () => parseManagedQuerySync(text),
    catch: (cause) => invalidQuery("The managed query could not be parsed safely.", String(cause)),
  });
  return result instanceof ManagedQueryError ? yield* result : result;
});

const quote = (value: string): string => {
  let escaped = "";
  for (const character of value) {
    if (character === "\\") escaped += "\\\\";
    else if (character === "'") escaped += "\\'";
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else {
      const codePoint = character.codePointAt(0) ?? 0;
      escaped +=
        codePoint < 32 || codePoint === 127
          ? `\\u${codePoint.toString(16).padStart(4, "0")}`
          : character;
    }
  }
  return `'${escaped}'`;
};
const renderLiteral = (literal: ManagedQueryLiteral): string => {
  if (literal.kind === "string") return quote(literal.value);
  if (literal.kind === "boolean") return literal.value ? "true" : "false";
  return String(literal.value);
};

const renderIdentifier = (identifier: string): string => `[${quote(identifier)}]`;

const compilationInput = Effect.fn("managedQueryCompilationInput")(function* (
  query: ManagedQuery,
  target: ManagedQueryTarget,
): Effect.fn.Return<typeof ManagedQueryCompilationInput.Type, ManagedQueryError> {
  const input = yield* decodeManagedQueryCompilationInput({ query, target }).pipe(
    Effect.mapError((cause) =>
      invalidQuery("The managed query cannot be compiled safely.", String(cause)),
    ),
  );
  const expectedBindingField = input.query.stream === "metrics" ? "metric.name" : "event.name";
  const bindings = input.query.stages.flatMap((stage) =>
    stage.kind === "where"
      ? stage.comparisons.filter((comparison) => comparison.field === input.query.binding.field)
      : [],
  );
  const binding = bindings[0];
  const identifiers = binding?.values.flatMap((value) =>
    value.kind === "string" ? [value.value] : [],
  );
  if (
    input.query.binding.field !== expectedBindingField ||
    bindings.length !== 1 ||
    binding === undefined ||
    (binding.operator !== "==" && binding.operator !== "in") ||
    identifiers === undefined ||
    identifiers.length !== binding.values.length ||
    identifiers.length !== input.query.binding.identifiers.length ||
    identifiers.some((identifier, index) => identifier !== input.query.binding.identifiers[index])
  ) {
    return yield* invalidQuery(
      "The managed query binding cannot be compiled safely.",
      input.query.binding.field,
    );
  }
  return input;
});

const renderAggregation = (aggregation: ManagedQueryAggregation): string => {
  if (aggregation.kind === "count") return "count()";
  if (aggregation.kind === "quantile") {
    return `percentile(${renderIdentifier(aggregation.field)}, ${aggregation.percentile})`;
  }
  return `${aggregation.function}(${renderIdentifier(aggregation.field)})`;
};

const renderGroup = (group: ManagedQueryGroup): string =>
  group.kind === "bin"
    ? `bin(${renderIdentifier(group.field)}, ${group.duration})`
    : renderIdentifier(group.field);

export const compileManagedQuery = Effect.fn("compileManagedQuery")(function* (
  query: ManagedQuery,
  target: ManagedQueryTarget,
): Effect.fn.Return<CompiledManagedQuery, ManagedQueryError> {
  const input = yield* compilationInput(query, target);
  const renderedStages = input.query.stages.map((stage) => {
    if (stage.kind === "summarize") {
      const groups = stage.groups.map(renderGroup);
      const suffix = groups.length === 0 ? "" : ` by ${groups.join(", ")}`;
      return `summarize ${renderAggregation(stage.aggregation)}${suffix}`;
    }
    const comparisons = stage.comparisons.map((comparison) => {
      if (comparison.field === input.query.binding.field) {
        return input.target.signals.length === 1
          ? `${renderIdentifier(comparison.field)} == ${quote(input.target.signals[0] ?? "")}`
          : `${renderIdentifier(comparison.field)} in (${input.target.signals.map(quote).join(", ")})`;
      }
      if (comparison.operator === "in") {
        return `${renderIdentifier(comparison.field)} in (${comparison.values.map(renderLiteral).join(", ")})`;
      }
      return `${renderIdentifier(comparison.field)} ${comparison.operator} ${comparison.values.map(renderLiteral).join("")}`;
    });
    return `where ${comparisons.join(" and ")}`;
  });
  const text = [renderIdentifier(input.target.dataset), ...renderedStages].join(" | ");
  return { dataset: input.target.dataset, language: input.target.language, text };
});
