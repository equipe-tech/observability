import { Context, Effect, Layer, Option, Schema } from "effect";
import type { AxiomCredentials } from "./CredentialsStore.ts";
import {
  axiomHeaders,
  axiomUrl,
  expectStatus,
  invalidResponse,
  remoteRequestWithTimeout,
  parseRemoteJson,
  RemoteApiError,
  resolveAxiomBaseUrl,
  resolveProviderRequestTimeout,
  type RemoteResponse,
} from "./ProviderApis.ts";

const DashboardVersion = Schema.String.check(Schema.isPattern(/^[0-9]{1,40}$/));
const TextWithDefault = Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")));
const NumberWithDefault = Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(-1)));
const BooleanWithDefault = Schema.Boolean.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(false)),
);

const QueryOptionValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
export type QueryOptionValue = typeof QueryOptionValue.Type;

const ObservedChartQuery = Schema.Struct({
  apl: Schema.String.pipe(Schema.optionalKey),
  mpl: Schema.String.pipe(Schema.optionalKey),
  queryOptions: Schema.Record(Schema.String, QueryOptionValue).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

export class ObservedDashboardChart extends Schema.Class<ObservedDashboardChart>(
  "@equipe-tech/observability-cli/ObservedDashboardChart",
)({
  id: TextWithDefault,
  name: TextWithDefault,
  type: TextWithDefault,
  datasetId: TextWithDefault,
  query: ObservedChartQuery.pipe(Schema.optionalKey),
}) {}

export class DashboardLayoutItem extends Schema.Class<DashboardLayoutItem>(
  "@equipe-tech/observability-cli/DashboardLayoutItem",
)({
  i: Schema.String,
  x: Schema.Int,
  y: Schema.Int,
  w: Schema.Int,
  h: Schema.Int,
}) {}

export class ObservedDashboardDocument extends Schema.Class<ObservedDashboardDocument>(
  "@equipe-tech/observability-cli/ObservedDashboardDocument",
)({
  name: TextWithDefault,
  owner: TextWithDefault,
  description: TextWithDefault,
  charts: Schema.Array(ObservedDashboardChart),
  layout: Schema.Array(DashboardLayoutItem),
  refreshTime: NumberWithDefault,
  schemaVersion: NumberWithDefault,
  timeWindowStart: TextWithDefault,
  timeWindowEnd: TextWithDefault,
}) {}

export class ObservedDashboard extends Schema.Class<ObservedDashboard>(
  "@equipe-tech/observability-cli/ObservedDashboard",
)({
  uid: Schema.NonEmptyString,
  version: DashboardVersion,
  dashboard: ObservedDashboardDocument,
}) {}

export class ObservedMonitor extends Schema.Class<ObservedMonitor>(
  "@equipe-tech/observability-cli/ObservedMonitor",
)({
  id: Schema.NonEmptyString,
  name: TextWithDefault,
  description: TextWithDefault,
  type: TextWithDefault,
  operator: TextWithDefault,
  threshold: NumberWithDefault,
  alertOnNoData: BooleanWithDefault,
  intervalMinutes: NumberWithDefault,
  rangeMinutes: NumberWithDefault,
  notifierIds: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  resolvable: BooleanWithDefault,
  disabled: BooleanWithDefault,
  disabledUntil: Schema.OptionFromOptionalKey(Schema.String),
  notifyByGroup: BooleanWithDefault,
  notifyEveryRun: BooleanWithDefault,
  triggerAfterNPositiveResults: NumberWithDefault,
  triggerFromNRuns: NumberWithDefault,
  aplQuery: TextWithDefault,
  mplQuery: TextWithDefault,
  updatedAt: TextWithDefault,
}) {}

export type DashboardChartQuery =
  | { readonly apl: string; readonly queryOptions: EmptyQueryOptions }
  | { readonly mpl: string; readonly queryOptions: EmptyQueryOptions };

export type EmptyQueryOptions = { readonly [key: string]: never };

export type DashboardChart = {
  readonly id: string;
  readonly name: string;
  readonly type: "TimeSeries";
  readonly datasetId: string;
  readonly query: DashboardChartQuery;
};

export type DashboardDocument = {
  readonly name: string;
  readonly owner: string;
  readonly description: string;
  readonly charts: ReadonlyArray<DashboardChart>;
  readonly layout: ReadonlyArray<DashboardLayoutItem>;
  readonly refreshTime: number;
  readonly schemaVersion: number;
  readonly timeWindowStart: string;
  readonly timeWindowEnd: string;
};

export type MonitorDocument = {
  readonly name: string;
  readonly description: string;
  readonly type: "Threshold";
  readonly operator: "Above" | "AboveOrEqual" | "Below" | "BelowOrEqual";
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
  readonly disabled?: boolean;
  readonly disabledUntil?: string;
  readonly aplQuery?: string;
  readonly mplQuery?: string;
};

const decodeObservedDashboard = Schema.decodeUnknownEffect(ObservedDashboard);
const decodeObservedMonitors = Schema.decodeUnknownEffect(Schema.Array(ObservedMonitor));

const quoteIntegerVersions = (content: string): string =>
  content.replace(/"version"(\s*):(\s*)([0-9]+)(?=\s*[,}\]])/g, '"version"$1:$2"$3"');

const resourceConflict = (resource: string, response: RemoteResponse): RemoteApiError =>
  new RemoteApiError({
    code: "OBS_CLI_AXIOM_RESOURCE_CONFLICT",
    message: `Axiom changed ${resource} concurrently or it already exists. Run ops plan again before applying.`,
    provider: "Axiom",
    status: response.status,
    cause: response.status,
  });

const dashboardPath = (uid: string): string => `/v2/dashboards/uid/${encodeURIComponent(uid)}`;

export class AxiomOperationsApi extends Context.Service<
  AxiomOperationsApi,
  {
    dashboard(
      credentials: AxiomCredentials,
      uid: string,
    ): Effect.Effect<Option.Option<ObservedDashboard>, RemoteApiError>;
    createDashboard(
      credentials: AxiomCredentials,
      uid: string,
      document: DashboardDocument,
    ): Effect.Effect<void, RemoteApiError>;
    updateDashboard(
      credentials: AxiomCredentials,
      uid: string,
      version: string,
      document: DashboardDocument,
    ): Effect.Effect<void, RemoteApiError>;
    monitors(
      credentials: AxiomCredentials,
    ): Effect.Effect<ReadonlyArray<ObservedMonitor>, RemoteApiError>;
    createMonitor(
      credentials: AxiomCredentials,
      document: MonitorDocument,
    ): Effect.Effect<void, RemoteApiError>;
    updateMonitor(
      credentials: AxiomCredentials,
      id: string,
      document: MonitorDocument,
    ): Effect.Effect<void, RemoteApiError>;
  }
>()("@equipe-tech/observability-cli/AxiomOperationsApi") {
  static readonly layer = Layer.effect(
    AxiomOperationsApi,
    Effect.gen(function* () {
      const timeoutMilliseconds = yield* resolveProviderRequestTimeout("Axiom");
      const baseUrl = yield* resolveAxiomBaseUrl();
      const remoteRequest = remoteRequestWithTimeout(timeoutMilliseconds);

      const write = Effect.fn("AxiomOperationsApi.write")(function* (
        credentials: AxiomCredentials,
        resource: string,
        method: "POST" | "PUT",
        path: string,
        body: string,
      ) {
        const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, path), {
          method,
          headers: axiomHeaders(credentials),
          body,
        });
        if (response.status === 409 || response.status === 412) {
          return yield* resourceConflict(resource, response);
        }
        yield* expectStatus("Axiom", response, [200, 201]);
      });

      return AxiomOperationsApi.of({
        dashboard: Effect.fn("AxiomOperationsApi.dashboard")(function* (credentials, uid) {
          const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, dashboardPath(uid)), {
            headers: axiomHeaders(credentials),
          });
          if (response.status === 404) return Option.none();
          yield* expectStatus("Axiom", response, [200]);
          const value = yield* parseRemoteJson("Axiom", {
            status: response.status,
            content: quoteIntegerVersions(response.content),
          });
          const dashboard = yield* decodeObservedDashboard(value).pipe(
            Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
          );
          if (dashboard.uid !== uid) {
            return yield* invalidResponse("Axiom", response.status, dashboard.uid);
          }
          return Option.some(dashboard);
        }),
        createDashboard: Effect.fn("AxiomOperationsApi.createDashboard")(
          function* (credentials, uid, document) {
            yield* write(
              credentials,
              `dashboard ${uid}`,
              "POST",
              "/v2/dashboards",
              JSON.stringify({ uid, dashboard: document, overwrite: false }),
            );
          },
        ),
        updateDashboard: Effect.fn("AxiomOperationsApi.updateDashboard")(
          function* (credentials, uid, version, document) {
            const fields = JSON.stringify({ dashboard: document, overwrite: false });
            yield* write(
              credentials,
              `dashboard ${uid}`,
              "PUT",
              dashboardPath(uid),
              `${fields.slice(0, -1)},"version":${version}}`,
            );
          },
        ),
        monitors: Effect.fn("AxiomOperationsApi.monitors")(function* (credentials) {
          const response = yield* remoteRequest("Axiom", axiomUrl(baseUrl, "/v2/monitors"), {
            headers: axiomHeaders(credentials),
          });
          yield* expectStatus("Axiom", response, [200]);
          const value = yield* parseRemoteJson("Axiom", response);
          return yield* decodeObservedMonitors(value).pipe(
            Effect.mapError((cause) => invalidResponse("Axiom", response.status, cause)),
          );
        }),
        createMonitor: Effect.fn("AxiomOperationsApi.createMonitor")(
          function* (credentials, document) {
            yield* write(
              credentials,
              `monitor ${document.name}`,
              "POST",
              "/v2/monitors",
              JSON.stringify(document),
            );
          },
        ),
        updateMonitor: Effect.fn("AxiomOperationsApi.updateMonitor")(
          function* (credentials, id, document) {
            yield* write(
              credentials,
              `monitor ${document.name}`,
              "PUT",
              `/v2/monitors/${encodeURIComponent(id)}`,
              JSON.stringify(document),
            );
          },
        ),
      });
    }),
  );
}
