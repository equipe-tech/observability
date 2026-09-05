import { Effect, Option, Schema } from "effect";

const AxiomEnvironment = Schema.Struct({
  AXIOM_URL: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://api.axiom.co")),
  ),
  AXIOM_READ_TOKEN: Schema.NonEmptyString,
  AXIOM_ORGANIZATION_ID: Schema.NonEmptyString,
  AXIOM_DATASET_TRACES: Schema.NonEmptyString,
  AXIOM_DATASET_LOGS: Schema.NonEmptyString,
  AXIOM_DATASET_METRICS: Schema.NonEmptyString,
});

export type AxiomEnvironment = typeof AxiomEnvironment.Type;

export const decodeAxiomEnvironment = Schema.decodeUnknownEffect(AxiomEnvironment);

const QueryResponse = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ data: Schema.Unknown })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

const decodeQueryResponse = Schema.decodeUnknownEffect(QueryResponse);
const decodeProviderResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const queryStartTime = (): string => new Date(Date.now() - 30 * 60 * 1000).toISOString();
const queryEndTime = (): string => new Date().toISOString();

export type AxiomQueryObserver = (response: string) => Effect.Effect<void>;

export type AxiomQueryOptions = {
  readonly observe?: AxiomQueryObserver;
  readonly timeoutMilliseconds?: number;
};

const noopQueryObserver: AxiomQueryObserver = () => Effect.void;
const defaultQueryTimeoutMilliseconds = 10_000;
const summarizeResponse = (payload: string): string => payload.slice(0, 500);

const runQuery = (
  env: AxiomEnvironment,
  apl: string,
  options: AxiomQueryOptions,
): Effect.Effect<ReadonlyArray<unknown>> =>
  Effect.gen(function* () {
    const response = yield* Effect.promise((signal) =>
      fetch(`${env.AXIOM_URL}/v1/datasets/_apl?format=legacy`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.AXIOM_READ_TOKEN}`,
          "content-type": "application/json",
          "x-axiom-org-id": env.AXIOM_ORGANIZATION_ID,
        },
        body: JSON.stringify({ apl, startTime: queryStartTime() }),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(options.timeoutMilliseconds ?? defaultQueryTimeoutMilliseconds),
        ]),
      }),
    );
    const payload = yield* Effect.promise(() => response.text());
    const summary = summarizeResponse(payload);
    yield* (options.observe ?? noopQueryObserver)(`status=${response.status} body=${summary}`);
    if (!response.ok) {
      return yield* Effect.die(`Axiom query failed with status ${response.status}: ${summary}`);
    }
    const decodedPayload = yield* decodeProviderResponse(payload).pipe(Effect.orDie);
    const decoded = yield* decodeQueryResponse(decodedPayload).pipe(Effect.orDie);
    return decoded.matches.map((match) => match.data);
  });

const runMetricsQuery = Effect.fn("runMetricsQuery")(function* (
  env: AxiomEnvironment,
  mpl: string,
  options: AxiomQueryOptions,
): Effect.fn.Return<string, never> {
  const response = yield* Effect.promise((signal) =>
    fetch(`${env.AXIOM_URL}/v1/query/_mpl?format=metrics-v2`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AXIOM_READ_TOKEN}`,
        "content-type": "application/json",
        "x-axiom-org-id": env.AXIOM_ORGANIZATION_ID,
      },
      body: JSON.stringify({ mpl, startTime: queryStartTime(), endTime: queryEndTime() }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(options.timeoutMilliseconds ?? defaultQueryTimeoutMilliseconds),
      ]),
    }),
  );
  const payload = yield* Effect.promise(() => response.text());
  const summary = summarizeResponse(payload);
  yield* (options.observe ?? noopQueryObserver)(`status=${response.status} body=${summary}`);
  if (!response.ok) {
    return yield* Effect.die(
      `Axiom metrics query failed with status ${response.status}: ${summary}`,
    );
  }
  const decoded = yield* decodeProviderResponse(payload).pipe(Effect.orDie);
  return JSON.stringify(decoded);
});

const OptionalString = Schema.NullOr(Schema.String).pipe(Schema.optionalKey);

const AxiomRedactionRowFields = {
  authorization: OptionalString,
  password: OptionalString,
  access_token: OptionalString,
  user_password: OptionalString,
  phone_number: OptionalString,
  tokenizer: OptionalString,
  documentation: OptionalString,
  safe_message: OptionalString,
};

const AxiomRedactionRow = Schema.Struct(AxiomRedactionRowFields);

type AxiomRedactionRow = typeof AxiomRedactionRow.Type;

export type AxiomRedactionAttributes = {
  readonly authorization: Option.Option<string>;
  readonly password: Option.Option<string>;
  readonly accessToken: Option.Option<string>;
  readonly userPassword: Option.Option<string>;
  readonly phoneNumber: Option.Option<string>;
  readonly tokenizer: Option.Option<string>;
  readonly documentation: Option.Option<string>;
  readonly safeMessage: Option.Option<string>;
};

const toAxiomRedactionAttributes = (row: AxiomRedactionRow): AxiomRedactionAttributes => ({
  authorization: Option.fromNullishOr(row.authorization),
  password: Option.fromNullishOr(row.password),
  accessToken: Option.fromNullishOr(row.access_token),
  userPassword: Option.fromNullishOr(row.user_password),
  phoneNumber: Option.fromNullishOr(row.phone_number),
  tokenizer: Option.fromNullishOr(row.tokenizer),
  documentation: Option.fromNullishOr(row.documentation),
  safeMessage: Option.fromNullishOr(row.safe_message),
});

const redactionProjection =
  "authorization = tostring(['attributes.custom']['http.authorization']), password = tostring(['attributes.custom']['user.password']), access_token = tostring(['attributes.custom']['auth.access_token']), user_password = tostring(['attributes.custom']['profile.password']), phone_number = tostring(['attributes.custom']['contact.phone']), tokenizer = tostring(['attributes.custom']['tool.tokenizer']), documentation = tostring(['attributes.custom']['docs.documentation']), safe_message = tostring(['attributes.custom']['safe.message'])";

const AxiomSpanRow = Schema.Struct({
  trace_id: Schema.NonEmptyString,
  span_id: Schema.NonEmptyString,
  parent_span_id: OptionalString,
  name: Schema.NonEmptyString,
  service_namespace: OptionalString,
  service_name: OptionalString,
  service_version: OptionalString,
  service_instance_id: OptionalString,
  environment_name: OptionalString,
  environment_alias: OptionalString,
  events: OptionalString,
  ...AxiomRedactionRowFields,
});

const decodeAxiomSpanRow = Schema.decodeUnknownOption(AxiomSpanRow);

export type AxiomSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: Option.Option<string>;
  readonly name: string;
  readonly serviceNamespace: Option.Option<string>;
  readonly serviceName: Option.Option<string>;
  readonly serviceVersion: Option.Option<string>;
  readonly serviceInstanceId: Option.Option<string>;
  readonly environmentName: Option.Option<string>;
  readonly environmentAlias: Option.Option<string>;
  readonly events: Option.Option<string>;
  readonly redaction: AxiomRedactionAttributes;
};

const toAxiomSpan = (row: typeof AxiomSpanRow.Type): AxiomSpan => ({
  traceId: row.trace_id,
  spanId: row.span_id,
  parentSpanId: Option.fromNullishOr(row.parent_span_id).pipe(
    Option.filter((value) => value !== ""),
  ),
  name: row.name,
  serviceNamespace: Option.fromNullishOr(row.service_namespace),
  serviceName: Option.fromNullishOr(row.service_name),
  serviceVersion: Option.fromNullishOr(row.service_version),
  serviceInstanceId: Option.fromNullishOr(row.service_instance_id),
  environmentName: Option.fromNullishOr(row.environment_name),
  environmentAlias: Option.fromNullishOr(row.environment_alias),
  events: Option.fromNullishOr(row.events),
  redaction: toAxiomRedactionAttributes(row),
});

export const axiomServiceResourceFields = Object.freeze({
  namespace: "['resource.custom']['service.namespace']",
  name: "['service.name']",
  version: "['service.version']",
});

const serviceNamespacePath = axiomServiceResourceFields.namespace;
const serviceNamePath = axiomServiceResourceFields.name;
const serviceVersionPath = axiomServiceResourceFields.version;

const spanProjection = `project trace_id, span_id, parent_span_id, name, service_namespace = tostring(${serviceNamespacePath}), service_name = tostring(${serviceNamePath}), service_version = tostring(${serviceVersionPath}), service_instance_id = tostring(['resource.custom']['service.instance.id']), environment_name = tostring(['resource.custom']['deployment.environment.name']), environment_alias = tostring(['resource.custom']['deployment.environment']), events = tostring(events), ${redactionProjection}`;

export const findRootSpan = (
  env: AxiomEnvironment,
  runId: string,
  serviceVersion: string,
  options: AxiomQueryOptions = {},
): Effect.Effect<Option.Option<AxiomSpan>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_TRACES}'] | where ['attributes.custom']['canary.run_id'] == '${runId}' and ${serviceVersionPath} == '${serviceVersion}' and name == 'canary.operation' | ${spanProjection}`,
    options,
  ).pipe(
    Effect.map((rows) =>
      Option.fromNullishOr(rows[0]).pipe(
        Option.flatMap(decodeAxiomSpanRow),
        Option.map(toAxiomSpan),
      ),
    ),
  );

export const findChildSpan = (
  env: AxiomEnvironment,
  traceId: string,
  options: AxiomQueryOptions = {},
): Effect.Effect<Option.Option<AxiomSpan>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_TRACES}'] | where trace_id == '${traceId}' and name == 'canary.child' | ${spanProjection}`,
    options,
  ).pipe(
    Effect.map((rows) =>
      Option.fromNullishOr(rows[0]).pipe(
        Option.flatMap(decodeAxiomSpanRow),
        Option.map(toAxiomSpan),
      ),
    ),
  );

const AxiomLogRow = Schema.Struct({
  trace_id: OptionalString,
  event_name: Schema.NonEmptyString,
  event_kind: OptionalString,
  event_source: OptionalString,
  service_namespace: OptionalString,
  service_name: OptionalString,
  service_version: OptionalString,
  service_instance_id: OptionalString,
  environment_name: OptionalString,
  environment_alias: OptionalString,
  body: OptionalString,
  ...AxiomRedactionRowFields,
});

const decodeAxiomLogRow = Schema.decodeUnknownOption(AxiomLogRow);

export type AxiomLog = {
  readonly traceId: Option.Option<string>;
  readonly eventName: string;
  readonly eventKind: Option.Option<string>;
  readonly eventSource: Option.Option<string>;
  readonly serviceNamespace: Option.Option<string>;
  readonly serviceName: Option.Option<string>;
  readonly serviceVersion: Option.Option<string>;
  readonly serviceInstanceId: Option.Option<string>;
  readonly environmentName: Option.Option<string>;
  readonly environmentAlias: Option.Option<string>;
  readonly body: Option.Option<string>;
  readonly redaction: AxiomRedactionAttributes;
};

const toAxiomLog = (row: typeof AxiomLogRow.Type): AxiomLog => ({
  traceId: Option.fromNullishOr(row.trace_id).pipe(Option.filter((value) => value !== "")),
  eventName: row.event_name,
  eventKind: Option.fromNullishOr(row.event_kind),
  eventSource: Option.fromNullishOr(row.event_source),
  serviceNamespace: Option.fromNullishOr(row.service_namespace),
  serviceName: Option.fromNullishOr(row.service_name),
  serviceVersion: Option.fromNullishOr(row.service_version),
  serviceInstanceId: Option.fromNullishOr(row.service_instance_id),
  environmentName: Option.fromNullishOr(row.environment_name),
  environmentAlias: Option.fromNullishOr(row.environment_alias),
  body: Option.fromNullishOr(row.body),
  redaction: toAxiomRedactionAttributes(row),
});

export const findLogs = (
  env: AxiomEnvironment,
  runId: string,
  serviceVersion: string,
  options: AxiomQueryOptions = {},
): Effect.Effect<ReadonlyArray<AxiomLog>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_LOGS}'] | where ['attributes.custom']['canary.run_id'] == '${runId}' and ${serviceVersionPath} == '${serviceVersion}' | project trace_id, event_name = tostring(['attributes.custom']['event.name']), event_kind = tostring(['attributes.custom']['event.kind']), event_source = tostring(['attributes.custom']['event.source']), service_namespace = tostring(${serviceNamespacePath}), service_name = tostring(${serviceNamePath}), service_version = tostring(${serviceVersionPath}), service_instance_id = tostring(['resource.custom']['service.instance.id']), environment_name = tostring(['resource.custom']['deployment.environment.name']), environment_alias = tostring(['resource.custom']['deployment.environment']), body = tostring(body), ${redactionProjection}`,
    options,
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) =>
        decodeAxiomLogRow(row).pipe(
          Option.map(toAxiomLog),
          Option.match({ onNone: () => [], onSome: (log) => [log] }),
        ),
      ),
    ),
  );

export type AxiomMetric = {
  readonly content: string;
};

export const findMetric = (
  env: AxiomEnvironment,
  runId: string,
  environment: string,
  serviceName: string,
  serviceVersion: string,
  options: AxiomQueryOptions = {},
): Effect.Effect<Option.Option<AxiomMetric>> =>
  runMetricsQuery(
    env,
    `\`${env.AXIOM_DATASET_METRICS}\`:\`canary.operations\` | where \`canary.run_id\` == "${runId}" and \`service.namespace\` == "equipe-tech" and \`service.name\` == "${serviceName}" and \`service.version\` == "${serviceVersion}" and \`deployment.environment.name\` == "${environment}" and \`deployment.environment\` == "${environment}"`,
    options,
  ).pipe(
    Effect.map((content) =>
      content.includes(runId) ? Option.some({ content }) : Option.none<AxiomMetric>(),
    ),
  );
