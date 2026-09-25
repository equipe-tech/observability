import { Effect } from "effect";
import type {
  QueryOptionValue,
  DashboardChart,
  DashboardDocument,
  MonitorDocument,
  ObservedDashboard,
  ObservedMonitor,
} from "./AxiomOperationsApi.ts";
import { DashboardLayoutItem } from "./AxiomOperationsApi.ts";
import { compileAxiomQuery, type AxiomQuery } from "./AxiomQuery.ts";
import type { ManagedQuery, ManagedQueryError } from "./ManagedQuery.ts";
import {
  monitorDurationMinutes,
  OperationsManifestError,
  type MonitorDefinition,
  type ValidatedOperationsManifest,
} from "./OperationsManifest.ts";
import { environmentDatasets } from "./RemoteEnvironment.ts";

export type DesiredDashboard = {
  readonly kind: "dashboard";
  readonly actionId: string;
  readonly environment: string;
  readonly uid: string;
  readonly marker: string;
  readonly document: DashboardDocument;
  readonly fingerprint: string;
};

export type DesiredMonitor = {
  readonly kind: "monitor";
  readonly actionId: string;
  readonly environment: string;
  readonly resource: string;
  readonly marker: string;
  readonly document: MonitorDocument;
  readonly fingerprint: string;
};

export type DesiredAxiomResource = DesiredDashboard | DesiredMonitor;

const maximumDashboardUidLength = 128;
const everyoneOwner = "X-AXIOM-EVERYONE";
const panelWidth = 6;
const panelHeight = 4;
const panelsPerRow = 2;
const monitorEvaluationMinutes = 5;

const fingerprint = (value: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
};

export const managedMarker = (service: string, environment: string, slug: string): string =>
  `observability-managed:${service}/${environment}/${slug}`;

export const describesMarker = (description: string, marker: string): boolean =>
  description.split("\n").at(-1) === marker;

const chartQuery = (query: AxiomQuery): DashboardChart["query"] =>
  query.language === "apl"
    ? { apl: query.text, queryOptions: {} }
    : { mpl: query.text, queryOptions: {} };

const compileForEnvironment = Effect.fn("compileForEnvironment")(function* (
  validated: ValidatedOperationsManifest,
  environment: string,
  query: ManagedQuery,
): Effect.fn.Return<AxiomQuery, ManagedQueryError | OperationsManifestError> {
  const datasets = yield* environmentDatasets(validated.manifest.service, environment).pipe(
    Effect.mapError(
      (cause) =>
        new OperationsManifestError({
          code: "OBS_CLI_MANIFEST_INVALID",
          message: cause.message,
          issues: ["dataset name exceeds provider limits"],
          cause,
        }),
    ),
  );
  const [first, ...rest] = query.binding.identifiers;
  if (first === undefined) {
    return yield* new OperationsManifestError({
      code: "OBS_CLI_SOURCE_INVALID",
      message: "The managed query does not bind any signal.",
      issues: ["unbound managed query"],
      cause: query.binding.field,
    });
  }
  if (query.stream !== "metrics") {
    return yield* compileAxiomQuery(query, {
      language: "apl",
      dataset: datasets.logs,
      signals: [first, ...rest],
    });
  }
  const metric = validated.contract.metrics.find((entry) => entry.name === first);
  if (metric === undefined) {
    return yield* new OperationsManifestError({
      code: "OBS_CLI_SOURCE_INVALID",
      message: `Metric ${first} is not declared by the contract index.`,
      issues: [`unknown metric ${first}`],
      cause: first,
    });
  }
  return yield* compileAxiomQuery(query, {
    language: "mpl",
    dataset: datasets.metrics,
    signals: [first, ...rest],
    metricKind: metric.kind,
  });
});

type MonitorSettings = Omit<MonitorDocument, "aplQuery" | "mplQuery">;

const monitorOperator = (
  operator: MonitorDefinition["threshold"]["operator"],
): MonitorDocument["operator"] => {
  if (operator === ">") return "Above";
  if (operator === ">=") return "AboveOrEqual";
  if (operator === "<") return "Below";
  return "BelowOrEqual";
};

const monitorDescription = (definition: MonitorDefinition, marker: string): string =>
  [
    definition.title,
    `severity=${definition.severity} owner=${definition.owner} window=${definition.window} cooldown=${definition.cooldown} threshold=${definition.threshold.operator}${definition.threshold.value}${definition.threshold.unit}`,
    `runbook: ${definition.runbookUrl}`,
    marker,
  ].join("\n");

export const desiredAxiomResources = Effect.fn("desiredAxiomResources")(function* (
  validated: ValidatedOperationsManifest,
  environments: ReadonlyArray<string>,
  notifierIds: ReadonlyMap<string, string>,
): Effect.fn.Return<
  ReadonlyArray<DesiredAxiomResource>,
  ManagedQueryError | OperationsManifestError
> {
  const service = validated.manifest.service;
  const resources: Array<DesiredAxiomResource> = [];
  for (const environment of environments) {
    for (const dashboard of validated.dashboards) {
      const uid = `${service}-${environment}-${dashboard.definition.id}`;
      if (uid.length > maximumDashboardUidLength) {
        return yield* new OperationsManifestError({
          code: "OBS_CLI_MANIFEST_INVALID",
          message: `Dashboard uid ${uid} exceeds ${maximumDashboardUidLength} characters. Use a shorter dashboard id.`,
          issues: [`dashboard uid too long ${dashboard.definition.id}`],
          cause: uid.length,
        });
      }
      const charts: Array<DashboardChart> = [];
      const layout: Array<DashboardLayoutItem> = [];
      for (const [index, panel] of dashboard.panels.entries()) {
        const query = yield* compileForEnvironment(validated, environment, panel.query);
        charts.push({
          id: panel.definition.id,
          name: panel.definition.title,
          type: "TimeSeries",
          datasetId: query.dataset,
          query: chartQuery(query),
        });
        layout.push(
          new DashboardLayoutItem({
            i: panel.definition.id,
            x: (index % panelsPerRow) * panelWidth,
            y: Math.floor(index / panelsPerRow) * panelHeight,
            w: panelWidth,
            h: panelHeight,
          }),
        );
      }
      const marker = managedMarker(service, environment, dashboard.definition.id);
      const document: DashboardDocument = {
        name: `${dashboard.definition.title} (${environment})`,
        owner: everyoneOwner,
        description: marker,
        charts,
        layout,
        refreshTime: 300,
        schemaVersion: 2,
        timeWindowStart: "qr-now-24h",
        timeWindowEnd: "qr-now",
      };
      resources.push({
        kind: "dashboard",
        actionId: `axiom.dashboard.${environment}.${dashboard.definition.id}`,
        environment,
        uid,
        marker,
        document,
        fingerprint: desiredDashboardFingerprint(document),
      });
    }
    for (const monitor of validated.monitors) {
      const definition = monitor.definition;
      const query = yield* compileForEnvironment(validated, environment, monitor.query);
      const marker = managedMarker(service, environment, definition.id);
      const notifierId = notifierIds.get(definition.notifierRef);
      if (notifierId === undefined) {
        return yield* new OperationsManifestError({
          code: "OBS_CLI_MANIFEST_INVALID",
          message: `Monitor ${definition.id} references unresolved notifier ${definition.notifierRef}.`,
          issues: [`unresolved notifier ${definition.notifierRef}`],
          cause: definition.notifierRef,
        });
      }
      const windowMinutes = monitorDurationMinutes(definition.window);
      const base: MonitorSettings = {
        name: `${definition.title} (${environment})`,
        description: monitorDescription(definition, marker),
        type: "Threshold",
        operator: monitorOperator(definition.threshold.operator),
        threshold: definition.threshold.value,
        alertOnNoData: definition.noDataBehavior === "alert",
        intervalMinutes: Math.min(monitorEvaluationMinutes, windowMinutes),
        rangeMinutes: windowMinutes,
        notifierIds: [notifierId],
        resolvable: true,
        notifyByGroup: false,
        notifyEveryRun: false,
        triggerAfterNPositiveResults: 1,
        triggerFromNRuns: 1,
      };
      const document: MonitorDocument =
        query.language === "apl"
          ? { ...base, aplQuery: query.text }
          : { ...base, mplQuery: query.text };
      resources.push({
        kind: "monitor",
        actionId: `axiom.monitor.${environment}.${definition.id}`,
        environment,
        resource: `${service}-${environment}-${definition.id}`,
        marker,
        document,
        fingerprint: desiredMonitorFingerprint(document),
      });
    }
  }
  return resources;
});

type ChartProjection = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly datasetId: string;
  readonly apl: string;
  readonly mpl: string;
  readonly queryOptions: ReadonlyArray<readonly [string, string]>;
};

const providerQueryOptionDefaults = new Map([
  ["aggChartOpts", "{}"],
  ["containsTimeFilter", "false"],
  ["datasets", "[]"],
  ["editorContent", ""],
  ["endTime", ""],
  ["quickRange", ""],
  ["resultsHistogram", ""],
  ["selection", ""],
  ["shownColumns", ""],
  ["startTime", ""],
]);

const queryOptionsProjection = (options: {
  readonly [key: string]: QueryOptionValue;
}): ReadonlyArray<readonly [string, string]> =>
  Object.entries(options)
    .map(([key, value]): readonly [string, string] => [key, String(value)])
    .filter(([key, value]) => providerQueryOptionDefaults.get(key) !== value)
    .sort(([left], [right]) => left.localeCompare(right));

type LayoutProjection = {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

type DashboardProjection = {
  readonly name: string;
  readonly owner: string;
  readonly description: string;
  readonly charts: ReadonlyArray<ChartProjection>;
  readonly layout: ReadonlyArray<LayoutProjection>;
  readonly refreshTime: number;
  readonly schemaVersion: number;
  readonly timeWindowStart: string;
  readonly timeWindowEnd: string;
};

const layoutProjection = (layout: ReadonlyArray<DashboardLayoutItem>) =>
  layout
    .map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h }))
    .sort((left, right) => left.i.localeCompare(right.i));

const dashboardFingerprint = (projection: DashboardProjection): string =>
  fingerprint(JSON.stringify(projection));

const desiredChartProjection = (chart: DashboardChart): ChartProjection => ({
  id: chart.id,
  name: chart.name,
  type: chart.type,
  datasetId: chart.datasetId,
  apl: "apl" in chart.query ? chart.query.apl : "",
  mpl: "mpl" in chart.query ? chart.query.mpl : "",
  queryOptions: [],
});

export const desiredDashboardFingerprint = (document: DashboardDocument): string =>
  dashboardFingerprint({
    name: document.name,
    owner: document.owner,
    description: document.description,
    charts: document.charts.map(desiredChartProjection),
    layout: layoutProjection(document.layout),
    refreshTime: document.refreshTime,
    schemaVersion: document.schemaVersion,
    timeWindowStart: document.timeWindowStart,
    timeWindowEnd: document.timeWindowEnd,
  });

export const observedDashboardFingerprint = (observed: ObservedDashboard): string =>
  dashboardFingerprint({
    name: observed.dashboard.name,
    owner: observed.dashboard.owner,
    description: observed.dashboard.description,
    charts: observed.dashboard.charts.map((chart) => ({
      id: chart.id,
      name: chart.name,
      type: chart.type,
      datasetId: chart.datasetId,
      apl: chart.query?.apl ?? "",
      mpl: chart.query?.mpl ?? "",
      queryOptions: queryOptionsProjection(chart.query?.queryOptions ?? {}),
    })),
    layout: layoutProjection(observed.dashboard.layout),
    refreshTime: observed.dashboard.refreshTime,
    schemaVersion: observed.dashboard.schemaVersion,
    timeWindowStart: observed.dashboard.timeWindowStart,
    timeWindowEnd: observed.dashboard.timeWindowEnd,
  });

type MonitorProjection = {
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly operator: string;
  readonly threshold: number;
  readonly alertOnNoData: boolean;
  readonly intervalMinutes: number;
  readonly rangeMinutes: number;
  readonly notifierIds: ReadonlyArray<string>;
  readonly resolvable: boolean;
  readonly notifyByGroup: boolean;
  readonly notifyEveryRun: boolean;
  readonly triggerAfterNPositiveResults: number;
  readonly triggerFromNRuns: number;
  readonly query: string;
};

const monitorFingerprint = (projection: MonitorProjection): string =>
  fingerprint(JSON.stringify({ ...projection, notifierIds: [...projection.notifierIds].sort() }));

export const desiredMonitorFingerprint = (document: MonitorDocument): string =>
  monitorFingerprint({
    name: document.name,
    description: document.description,
    type: document.type,
    operator: document.operator,
    threshold: document.threshold,
    alertOnNoData: document.alertOnNoData,
    intervalMinutes: document.intervalMinutes,
    rangeMinutes: document.rangeMinutes,
    notifierIds: document.notifierIds,
    resolvable: document.resolvable,
    notifyByGroup: document.notifyByGroup,
    notifyEveryRun: document.notifyEveryRun,
    triggerAfterNPositiveResults: document.triggerAfterNPositiveResults,
    triggerFromNRuns: document.triggerFromNRuns,
    query: document.mplQuery ?? document.aplQuery ?? "",
  });

export const observedMonitorFingerprint = (observed: ObservedMonitor): string =>
  monitorFingerprint({
    name: observed.name,
    description: observed.description,
    type: observed.type,
    operator: observed.operator,
    threshold: observed.threshold,
    alertOnNoData: observed.alertOnNoData,
    intervalMinutes: observed.intervalMinutes,
    rangeMinutes: observed.rangeMinutes,
    notifierIds: observed.notifierIds,
    resolvable: observed.resolvable,
    notifyByGroup: observed.notifyByGroup,
    notifyEveryRun: observed.notifyEveryRun,
    triggerAfterNPositiveResults: observed.triggerAfterNPositiveResults,
    triggerFromNRuns: observed.triggerFromNRuns,
    query: observed.mplQuery === "" ? observed.aplQuery : observed.mplQuery,
  });

export const observedDashboardRevision = (observed: ObservedDashboard): string =>
  fingerprint(JSON.stringify([observedDashboardFingerprint(observed), observed.version]));

export const observedMonitorRevision = (observed: ObservedMonitor): string =>
  fingerprint(
    JSON.stringify([observedMonitorFingerprint(observed), observed.id, observed.updatedAt]),
  );
