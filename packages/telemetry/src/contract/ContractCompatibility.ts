import { Schema } from "effect";
import type {
  ContractSurface,
  ContractSurfaceAlias,
  ContractSurfaceAuditAction,
  ContractSurfaceEvent,
  ContractSurfaceMetric,
} from "./ContractSurface.ts";

export const CompatibilityCode = Schema.Literals([
  "OBS_COMPAT_EVENT_ADDED",
  "OBS_COMPAT_EVENT_REMOVED",
  "OBS_COMPAT_EVENT_RENAMED",
  "OBS_COMPAT_EVENT_KIND_CHANGED",
  "OBS_COMPAT_OUTCOME_MEANING_CHANGED",
  "OBS_COMPAT_ATTRIBUTE_ADDED",
  "OBS_COMPAT_ATTRIBUTE_REMOVED",
  "OBS_COMPAT_ATTRIBUTE_REQUIRED",
  "OBS_COMPAT_ATTRIBUTE_CLASSIFICATION_CHANGED",
  "OBS_COMPAT_ATTRIBUTE_METRIC_LABEL_CHANGED",
  "OBS_COMPAT_METRIC_ADDED",
  "OBS_COMPAT_METRIC_REMOVED",
  "OBS_COMPAT_METRIC_RENAMED",
  "OBS_COMPAT_METRIC_KIND_CHANGED",
  "OBS_COMPAT_METRIC_UNIT_CHANGED",
  "OBS_COMPAT_METRIC_BOUNDARIES_CHANGED",
  "OBS_COMPAT_METRIC_ATTRIBUTE_ADDED",
  "OBS_COMPAT_METRIC_ATTRIBUTE_REMOVED",
  "OBS_COMPAT_METRIC_ATTRIBUTE_CLASSIFICATION_CHANGED",
  "OBS_COMPAT_METRIC_CARDINALITY_LOWERED",
  "OBS_COMPAT_METRIC_ALLOWED_VALUES_NARROWED",
  "OBS_COMPAT_AUDIT_ACTION_ADDED",
  "OBS_COMPAT_AUDIT_ACTION_REMOVED",
  "OBS_COMPAT_AUDIT_ACTION_CHANGED",
  "OBS_COMPAT_ALIAS_ADDED",
  "OBS_COMPAT_ALIAS_REMOVED_EARLY",
  "OBS_COMPAT_ALIAS_WINDOW_RESET",
  "OBS_COMPAT_ALIAS_WINDOW_EXPIRED",
  "OBS_COMPAT_BROWSER_ENVELOPE_CHANGED",
  "OBS_COMPAT_RETENTION_WINDOW_RESET",
]);

export type CompatibilityCode = typeof CompatibilityCode.Type;

export type CompatibilitySeverity = "compatible" | "breaking" | "notice";
export type CompatibilityAliasStatus =
  | "not-required"
  | "missing"
  | "active"
  | "expiring"
  | "expired";

export type CompatibilityFinding = {
  readonly code: CompatibilityCode;
  readonly path: string;
  readonly severity: CompatibilitySeverity;
  readonly requiredContractVersion: number;
  readonly declaredContractVersion: number;
  readonly aliasStatus: CompatibilityAliasStatus;
  readonly satisfied: boolean;
};

export type CompatibilityReport = {
  readonly report: 1;
  readonly service: string;
  readonly baselineContractVersion: number;
  readonly candidateContractVersion: number;
  readonly requiredContractVersion: number;
  readonly accepted: boolean;
  readonly findings: ReadonlyArray<CompatibilityFinding>;
};

export type ContractCompatibilityInput = {
  readonly baseline: ContractSurface;
  readonly candidate: ContractSurface;
  readonly now: string;
};

type Named = { readonly name: string };
type ActionNamed = { readonly action: string };

const mapByName = <Entry extends Named>(
  entries: ReadonlyArray<Entry>,
): ReadonlyMap<string, Entry> => new Map(entries.map((entry) => [entry.name, entry]));
const mapByAction = <Entry extends ActionNamed>(
  entries: ReadonlyArray<Entry>,
): ReadonlyMap<string, Entry> => new Map(entries.map((entry) => [entry.action, entry]));
const same = (
  left: ReadonlyArray<string | number | boolean>,
  right: ReadonlyArray<string | number | boolean>,
): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const scalarKey = (value: string | number | boolean): string => JSON.stringify(value);
const containsAllowedScalars = (
  candidate: ReadonlyArray<string | number | boolean>,
  baseline: ReadonlyArray<string | number | boolean>,
): boolean => {
  if (candidate.length === 0) return true;
  if (baseline.length === 0) return false;
  const candidateKeys = new Set(candidate.map(scalarKey));
  return baseline.every((value) => candidateKeys.has(scalarKey(value)));
};
const containsStrings = (
  candidate: ReadonlyArray<string>,
  baseline: ReadonlyArray<string>,
): boolean => {
  const candidates = new Set(candidate);
  return baseline.every((value) => candidates.has(value));
};
const classificationRank = (
  classification: ContractSurfaceEvent["attributes"][number]["classification"],
): number =>
  classification === "public"
    ? 0
    : classification === "internal"
      ? 1
      : classification === "sensitive"
        ? 2
        : 3;
const eventAliasCompatible = (
  baseline: ContractSurfaceEvent,
  candidate: ContractSurfaceEvent | undefined,
): boolean =>
  candidate !== undefined &&
  baseline.kind === candidate.kind &&
  same(
    baseline.attributes
      .map((attribute) => `${attribute.name}\u0000${attribute.classification}`)
      .sort(),
    candidate.attributes
      .map((attribute) => `${attribute.name}\u0000${attribute.classification}`)
      .sort(),
  );
const metricAliasCompatible = (
  baseline: ContractSurfaceMetric,
  candidate: ContractSurfaceMetric | undefined,
): boolean =>
  candidate !== undefined &&
  baseline.kind === candidate.kind &&
  baseline.unit === candidate.unit &&
  same(
    baseline.attributes.map((attribute) => attribute.name).sort(),
    candidate.attributes.map((attribute) => attribute.name).sort(),
  );
const aliasKey = (alias: ContractSurfaceAlias): string =>
  `${alias.kind}\u0000${alias.from}\u0000${alias.to}`;

const dateDay = (date: string): number | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = Date.UTC(year, month - 1, day);
  const normalized = new Date(value).toISOString().slice(0, 10);
  return normalized === date ? Math.floor(value / 86_400_000) : undefined;
};

const aliasStatus = (
  alias: ContractSurfaceAlias | undefined,
  now: string,
  retentionWindowDays: number,
): CompatibilityAliasStatus => {
  if (alias === undefined) return "missing";
  const since = dateDay(alias.since);
  const today = dateDay(now);
  if (since === undefined || today === undefined) return "missing";
  const remaining = retentionWindowDays - (today - since);
  if (remaining <= 0) return "expired";
  return remaining <= Math.min(7, retentionWindowDays) ? "expiring" : "active";
};

const finding = (
  code: CompatibilityCode,
  path: string,
  severity: CompatibilitySeverity,
  baselineVersion: number,
  candidateVersion: number,
  status: CompatibilityAliasStatus = "not-required",
  extraSatisfied = true,
): CompatibilityFinding => {
  const requiredContractVersion = severity === "breaking" ? baselineVersion + 1 : baselineVersion;
  return {
    code,
    path,
    severity,
    requiredContractVersion,
    declaredContractVersion: candidateVersion,
    aliasStatus: status,
    satisfied:
      extraSatisfied && (severity !== "breaking" || candidateVersion >= requiredContractVersion),
  };
};

const eventAlias = (
  aliases: ReadonlyArray<ContractSurfaceAlias>,
  name: string,
): ContractSurfaceAlias | undefined =>
  aliases.find((alias) => alias.kind === "event" && alias.from === name);
const metricAlias = (
  aliases: ReadonlyArray<ContractSurfaceAlias>,
  name: string,
): ContractSurfaceAlias | undefined =>
  aliases.find((alias) => alias.kind === "metric" && alias.from === name);

const compareEventAttributes = (
  baseline: ContractSurfaceEvent,
  candidate: ContractSurfaceEvent,
  baselineVersion: number,
  candidateVersion: number,
): ReadonlyArray<CompatibilityFinding> => {
  const findings: Array<CompatibilityFinding> = [];
  const baselineAttributes = mapByName(baseline.attributes);
  const candidateAttributes = mapByName(candidate.attributes);
  for (const attribute of candidate.attributes) {
    if (!baselineAttributes.has(attribute.name)) {
      findings.push(
        finding(
          "OBS_COMPAT_ATTRIBUTE_ADDED",
          `events/${baseline.name}/attributes/${attribute.name}`,
          attribute.required ? "breaking" : "compatible",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
  }
  for (const attribute of baseline.attributes) {
    const next = candidateAttributes.get(attribute.name);
    const path = `events/${baseline.name}/attributes/${attribute.name}`;
    if (next === undefined) {
      findings.push(
        finding(
          "OBS_COMPAT_ATTRIBUTE_REMOVED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
      continue;
    }
    if (!attribute.required && next.required) {
      findings.push(
        finding(
          "OBS_COMPAT_ATTRIBUTE_REQUIRED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
    if (classificationRank(next.classification) > classificationRank(attribute.classification)) {
      findings.push(
        finding(
          "OBS_COMPAT_ATTRIBUTE_CLASSIFICATION_CHANGED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
    if (attribute.metricLabel !== next.metricLabel) {
      findings.push(
        finding(
          "OBS_COMPAT_ATTRIBUTE_METRIC_LABEL_CHANGED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
  }
  return findings;
};

const compareMetricAttributes = (
  baseline: ContractSurfaceMetric,
  candidate: ContractSurfaceMetric,
  baselineVersion: number,
  candidateVersion: number,
): ReadonlyArray<CompatibilityFinding> => {
  const findings: Array<CompatibilityFinding> = [];
  const baselineAttributes = mapByName(baseline.attributes);
  const candidateAttributes = mapByName(candidate.attributes);
  for (const attribute of candidate.attributes) {
    if (!baselineAttributes.has(attribute.name)) {
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_ATTRIBUTE_ADDED",
          `metrics/${baseline.name}/attributes/${attribute.name}`,
          "compatible",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
  }
  for (const attribute of baseline.attributes) {
    const next = candidateAttributes.get(attribute.name);
    const path = `metrics/${baseline.name}/attributes/${attribute.name}`;
    if (next === undefined) {
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_ATTRIBUTE_REMOVED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
      continue;
    }
    if (classificationRank(next.classification) > classificationRank(attribute.classification)) {
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_ATTRIBUTE_CLASSIFICATION_CHANGED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
    if (next.maximumCardinality < attribute.maximumCardinality) {
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_CARDINALITY_LOWERED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
    if (!containsAllowedScalars(next.allowedValues, attribute.allowedValues)) {
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_ALLOWED_VALUES_NARROWED",
          path,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
  }
  return findings;
};

const auditChanged = (
  baseline: ContractSurfaceAuditAction,
  candidate: ContractSurfaceAuditAction,
): boolean =>
  baseline.resourceType !== candidate.resourceType ||
  !same([...baseline.allowedOutcomes].sort(), [...candidate.allowedOutcomes].sort()) ||
  !containsStrings(candidate.reasonCodes, baseline.reasonCodes);

export const classifyContractChange = (input: ContractCompatibilityInput): CompatibilityReport => {
  const baselineVersion = input.baseline.contractVersion;
  const candidateVersion = input.candidate.contractVersion;
  const findings: Array<CompatibilityFinding> = [];
  const baselineEvents = mapByName(input.baseline.events);
  const candidateEvents = mapByName(input.candidate.events);
  for (const event of input.candidate.events) {
    if (!baselineEvents.has(event.name)) {
      findings.push(
        finding(
          "OBS_COMPAT_EVENT_ADDED",
          `events/${event.name}`,
          "compatible",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
  }
  for (const event of input.baseline.events) {
    const next = candidateEvents.get(event.name);
    if (next === undefined) {
      const alias = eventAlias(input.candidate.aliases, event.name);
      const status = aliasStatus(alias, input.now, input.baseline.retentionWindowDays);
      const target = alias === undefined ? undefined : candidateEvents.get(alias.to);
      findings.push(
        finding(
          alias === undefined ? "OBS_COMPAT_EVENT_REMOVED" : "OBS_COMPAT_EVENT_RENAMED",
          `events/${event.name}`,
          "breaking",
          baselineVersion,
          candidateVersion,
          status,
          alias !== undefined && status !== "missing" && eventAliasCompatible(event, target),
        ),
      );
      continue;
    }
    if (event.kind !== next.kind) {
      findings.push(
        finding(
          "OBS_COMPAT_EVENT_KIND_CHANGED",
          `events/${event.name}/kind`,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
    if (!same(event.outcomeMeaning, next.outcomeMeaning)) {
      findings.push(
        finding(
          "OBS_COMPAT_OUTCOME_MEANING_CHANGED",
          `events/${event.name}/outcomeMeaning`,
          "breaking",
          baselineVersion,
          candidateVersion,
          "not-required",
          false,
        ),
      );
    }
    findings.push(...compareEventAttributes(event, next, baselineVersion, candidateVersion));
  }
  const baselineMetrics = mapByName(input.baseline.metrics);
  const candidateMetrics = mapByName(input.candidate.metrics);
  for (const metric of input.candidate.metrics) {
    if (!baselineMetrics.has(metric.name)) {
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_ADDED",
          `metrics/${metric.name}`,
          "compatible",
          baselineVersion,
          candidateVersion,
        ),
      );
    }
  }
  for (const metric of input.baseline.metrics) {
    const next = candidateMetrics.get(metric.name);
    if (next === undefined) {
      const alias = metricAlias(input.candidate.aliases, metric.name);
      const status = aliasStatus(alias, input.now, input.baseline.retentionWindowDays);
      const target = alias === undefined ? undefined : candidateMetrics.get(alias.to);
      findings.push(
        finding(
          alias === undefined ? "OBS_COMPAT_METRIC_REMOVED" : "OBS_COMPAT_METRIC_RENAMED",
          `metrics/${metric.name}`,
          "breaking",
          baselineVersion,
          candidateVersion,
          status,
          alias !== undefined && status !== "missing" && metricAliasCompatible(metric, target),
        ),
      );
      continue;
    }
    if (metric.kind !== next.kind)
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_KIND_CHANGED",
          `metrics/${metric.name}/kind`,
          "breaking",
          baselineVersion,
          candidateVersion,
          "not-required",
          false,
        ),
      );
    if (metric.unit !== next.unit)
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_UNIT_CHANGED",
          `metrics/${metric.name}/unit`,
          "breaking",
          baselineVersion,
          candidateVersion,
          "not-required",
          false,
        ),
      );
    if (!same(metric.boundaries, next.boundaries))
      findings.push(
        finding(
          "OBS_COMPAT_METRIC_BOUNDARIES_CHANGED",
          `metrics/${metric.name}/boundaries`,
          "breaking",
          baselineVersion,
          candidateVersion,
          "not-required",
          false,
        ),
      );
    findings.push(...compareMetricAttributes(metric, next, baselineVersion, candidateVersion));
  }
  const baselineActions = mapByAction(input.baseline.auditActions);
  const candidateActions = mapByAction(input.candidate.auditActions);
  for (const action of input.candidate.auditActions) {
    if (!baselineActions.has(action.action))
      findings.push(
        finding(
          "OBS_COMPAT_AUDIT_ACTION_ADDED",
          `auditActions/${action.action}`,
          "compatible",
          baselineVersion,
          candidateVersion,
        ),
      );
  }
  for (const action of input.baseline.auditActions) {
    const next = candidateActions.get(action.action);
    if (next === undefined)
      findings.push(
        finding(
          "OBS_COMPAT_AUDIT_ACTION_REMOVED",
          `auditActions/${action.action}`,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
    else if (auditChanged(action, next))
      findings.push(
        finding(
          "OBS_COMPAT_AUDIT_ACTION_CHANGED",
          `auditActions/${action.action}`,
          "breaking",
          baselineVersion,
          candidateVersion,
        ),
      );
  }
  const baselineAliases = new Map(input.baseline.aliases.map((alias) => [aliasKey(alias), alias]));
  const candidateAliases = new Map(
    input.candidate.aliases.map((alias) => [aliasKey(alias), alias]),
  );
  for (const alias of input.candidate.aliases) {
    const previous = baselineAliases.get(aliasKey(alias));
    const status = aliasStatus(alias, input.now, input.baseline.retentionWindowDays);
    if (previous === undefined)
      findings.push(
        finding(
          "OBS_COMPAT_ALIAS_ADDED",
          `aliases/${alias.kind}/${alias.from}/${alias.to}`,
          "compatible",
          baselineVersion,
          candidateVersion,
          status,
        ),
      );
    else if (previous.since !== alias.since)
      findings.push(
        finding(
          "OBS_COMPAT_ALIAS_WINDOW_RESET",
          `aliases/${alias.kind}/${alias.from}/${alias.to}/since`,
          "breaking",
          baselineVersion,
          candidateVersion,
          status,
          false,
        ),
      );
    if (status === "expired")
      findings.push(
        finding(
          "OBS_COMPAT_ALIAS_WINDOW_EXPIRED",
          `aliases/${alias.kind}/${alias.from}/${alias.to}`,
          "notice",
          baselineVersion,
          candidateVersion,
          status,
        ),
      );
  }
  for (const alias of input.baseline.aliases) {
    if (candidateAliases.has(aliasKey(alias))) continue;
    const status = aliasStatus(alias, input.now, input.baseline.retentionWindowDays);
    if (status !== "expired")
      findings.push(
        finding(
          "OBS_COMPAT_ALIAS_REMOVED_EARLY",
          `aliases/${alias.kind}/${alias.from}/${alias.to}`,
          "breaking",
          baselineVersion,
          candidateVersion,
          status,
          false,
        ),
      );
  }
  const baselineBrowser = input.baseline.browserEnvelope;
  const candidateBrowser = input.candidate.browserEnvelope;
  const browserFieldsChanged =
    !same(baselineBrowser.batchFields, candidateBrowser.batchFields) ||
    !same(baselineBrowser.eventFields, candidateBrowser.eventFields);
  if (browserFieldsChanged && candidateBrowser.version <= baselineBrowser.version) {
    findings.push(
      finding(
        "OBS_COMPAT_BROWSER_ENVELOPE_CHANGED",
        "browserEnvelope",
        "breaking",
        baselineVersion,
        candidateVersion,
        "not-required",
        false,
      ),
    );
  }
  if (input.candidate.retentionWindowDays < input.baseline.retentionWindowDays) {
    findings.push(
      finding(
        "OBS_COMPAT_RETENTION_WINDOW_RESET",
        "retentionWindowDays",
        "breaking",
        baselineVersion,
        candidateVersion,
        "not-required",
        false,
      ),
    );
  }
  findings.sort((left, right) =>
    `${left.path}\u0000${left.code}`.localeCompare(`${right.path}\u0000${right.code}`),
  );
  const requiredContractVersion = findings.reduce(
    (required, entry) => Math.max(required, entry.requiredContractVersion),
    baselineVersion,
  );
  return {
    report: 1,
    service: input.candidate.service,
    baselineContractVersion: baselineVersion,
    candidateContractVersion: candidateVersion,
    requiredContractVersion,
    accepted:
      input.baseline.service === input.candidate.service &&
      findings.every((entry) => entry.satisfied),
    findings,
  };
};

export const encodeCompatibilityReport = (report: CompatibilityReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;
