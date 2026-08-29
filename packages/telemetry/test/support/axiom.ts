import { Effect, Option, Schema } from "effect";

const AxiomEnvironment = Schema.Struct({
  AXIOM_URL: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://api.axiom.co")),
  ),
  AXIOM_TOKEN: Schema.NonEmptyString,
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
const decodeMetricsResponse = Schema.decodeUnknownEffect(Schema.Json);

const queryStartTime = (): string => new Date(Date.now() - 30 * 60 * 1000).toISOString();
const queryEndTime = (): string => new Date().toISOString();

const runQuery = (env: AxiomEnvironment, apl: string): Effect.Effect<ReadonlyArray<unknown>> =>
  Effect.gen(function* () {
    const response = yield* Effect.promise((signal) =>
      fetch(`${env.AXIOM_URL}/v1/datasets/_apl?format=legacy`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.AXIOM_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ apl, startTime: queryStartTime() }),
        signal,
      }),
    );
    const payload: unknown = yield* Effect.promise(() => response.json());
    if (!response.ok) {
      return yield* Effect.die(
        `Axiom query failed with status ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }
    const decoded = yield* decodeQueryResponse(payload).pipe(Effect.orDie);
    return decoded.matches.map((match) => match.data);
  });

const runMetricsQuery = Effect.fn("runMetricsQuery")(function* (
  env: AxiomEnvironment,
  mpl: string,
): Effect.fn.Return<string, never> {
  const response = yield* Effect.promise((signal) =>
    fetch(`${env.AXIOM_URL}/v1/query/_mpl?format=metrics-v2`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AXIOM_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mpl, startTime: queryStartTime(), endTime: queryEndTime() }),
      signal,
    }),
  );
  const payload: unknown = yield* Effect.promise(() => response.json());
  if (!response.ok) {
    return yield* Effect.die(
      `Axiom metrics query failed with status ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`,
    );
  }
  const decoded = yield* decodeMetricsResponse(payload).pipe(Effect.orDie);
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
  "authorization = tostring(['attributes.custom']['authorization']), password = tostring(['attributes.custom']['password']), access_token = tostring(['attributes.custom']['accessToken']), user_password = tostring(['attributes.custom']['userPassword']), phone_number = tostring(['attributes.custom']['phoneNumber']), tokenizer = tostring(['attributes.custom']['tokenizer']), documentation = tostring(['attributes.custom']['documentation']), safe_message = tostring(['attributes.custom']['safe.message'])";

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

const spanProjection = `project trace_id, span_id, parent_span_id, name, service_namespace = tostring(['resource.custom']['service.namespace']), service_name = ['service.name'], service_version = ['service.version'], service_instance_id = tostring(['resource.custom']['service.instance.id']), environment_name = tostring(['resource.custom']['deployment.environment.name']), environment_alias = tostring(['resource.custom']['deployment.environment']), events = tostring(events), ${redactionProjection}`;

export const findRootSpan = (
  env: AxiomEnvironment,
  runId: string,
): Effect.Effect<Option.Option<AxiomSpan>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_TRACES}'] | where ['attributes.custom']['canary.run_id'] == '${runId}' and name == 'canary.operation' | ${spanProjection}`,
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
): Effect.Effect<Option.Option<AxiomSpan>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_TRACES}'] | where trace_id == '${traceId}' and name == 'canary.child' | ${spanProjection}`,
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
  serviceInstanceId: Option.fromNullishOr(row.service_instance_id),
  environmentName: Option.fromNullishOr(row.environment_name),
  environmentAlias: Option.fromNullishOr(row.environment_alias),
  body: Option.fromNullishOr(row.body),
  redaction: toAxiomRedactionAttributes(row),
});

export const findLogs = (
  env: AxiomEnvironment,
  runId: string,
): Effect.Effect<ReadonlyArray<AxiomLog>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_LOGS}'] | where ['attributes.custom']['canary.run_id'] == '${runId}' | project trace_id, event_name = tostring(['attributes.custom']['event.name']), event_kind = tostring(['attributes.custom']['event.kind']), event_source = tostring(['attributes.custom']['event.source']), service_namespace = tostring(['resource.custom']['service.namespace']), service_name = ['service.name'], service_instance_id = tostring(['resource.custom']['service.instance.id']), environment_name = tostring(['resource.custom']['deployment.environment.name']), environment_alias = tostring(['resource.custom']['deployment.environment']), body = tostring(body), ${redactionProjection}`,
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
): Effect.Effect<Option.Option<AxiomMetric>> =>
  runMetricsQuery(
    env,
    `\`${env.AXIOM_DATASET_METRICS}\`:\`canary.operations\` | where \`canary.run_id\` == "${runId}" and \`service.namespace\` == "equipe-tech" and \`service.name\` == "${serviceName}" and \`service.version\` == "${serviceVersion}" and \`deployment.environment.name\` == "${environment}" and \`deployment.environment\` == "${environment}"`,
  ).pipe(
    Effect.map((content) =>
      content.includes(runId) ? Option.some({ content }) : Option.none<AxiomMetric>(),
    ),
  );
