import { Effect, Option, Schema } from "effect";

const AxiomEnvironment = Schema.Struct({
  AXIOM_URL: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://api.axiom.co")),
  ),
  AXIOM_TOKEN: Schema.NonEmptyString,
  AXIOM_DATASET_TRACES: Schema.NonEmptyString,
  AXIOM_DATASET_LOGS: Schema.NonEmptyString,
});

export type AxiomEnvironment = typeof AxiomEnvironment.Type;

export const decodeAxiomEnvironment = Schema.decodeUnknownEffect(AxiomEnvironment);

const QueryResponse = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ data: Schema.Unknown })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

const decodeQueryResponse = Schema.decodeUnknownEffect(QueryResponse);

const queryStartTime = (): string => new Date(Date.now() - 30 * 60 * 1000).toISOString();

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

const OptionalString = Schema.NullOr(Schema.String).pipe(Schema.optionalKey);

const AxiomSpanRow = Schema.Struct({
  trace_id: Schema.NonEmptyString,
  span_id: Schema.NonEmptyString,
  parent_span_id: OptionalString,
  name: Schema.NonEmptyString,
  service_name: OptionalString,
  service_version: OptionalString,
  environment: OptionalString,
  events: OptionalString,
});

const decodeAxiomSpanRow = Schema.decodeUnknownOption(AxiomSpanRow);

export type AxiomSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: Option.Option<string>;
  readonly name: string;
  readonly serviceName: Option.Option<string>;
  readonly serviceVersion: Option.Option<string>;
  readonly environment: Option.Option<string>;
  readonly events: Option.Option<string>;
};

const toAxiomSpan = (row: typeof AxiomSpanRow.Type): AxiomSpan => ({
  traceId: row.trace_id,
  spanId: row.span_id,
  parentSpanId: Option.fromNullishOr(row.parent_span_id).pipe(
    Option.filter((value) => value !== ""),
  ),
  name: row.name,
  serviceName: Option.fromNullishOr(row.service_name),
  serviceVersion: Option.fromNullishOr(row.service_version),
  environment: Option.fromNullishOr(row.environment),
  events: Option.fromNullishOr(row.events),
});

const spanProjection =
  "project trace_id, span_id, parent_span_id, name, service_name = ['service.name'], service_version = ['service.version'], environment = tostring(['resource.custom']['deployment.environment.name']), events = tostring(events)";

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
  service_name: OptionalString,
  body: OptionalString,
  authorization: OptionalString,
  password: OptionalString,
  safe_message: OptionalString,
});

const decodeAxiomLogRow = Schema.decodeUnknownOption(AxiomLogRow);

export type AxiomLog = {
  readonly traceId: Option.Option<string>;
  readonly eventName: string;
  readonly eventKind: Option.Option<string>;
  readonly eventSource: Option.Option<string>;
  readonly serviceName: Option.Option<string>;
  readonly body: Option.Option<string>;
  readonly authorization: Option.Option<string>;
  readonly password: Option.Option<string>;
  readonly safeMessage: Option.Option<string>;
};

const toAxiomLog = (row: typeof AxiomLogRow.Type): AxiomLog => ({
  traceId: Option.fromNullishOr(row.trace_id).pipe(Option.filter((value) => value !== "")),
  eventName: row.event_name,
  eventKind: Option.fromNullishOr(row.event_kind),
  eventSource: Option.fromNullishOr(row.event_source),
  serviceName: Option.fromNullishOr(row.service_name),
  body: Option.fromNullishOr(row.body),
  authorization: Option.fromNullishOr(row.authorization),
  password: Option.fromNullishOr(row.password),
  safeMessage: Option.fromNullishOr(row.safe_message),
});

export const findLogs = (
  env: AxiomEnvironment,
  runId: string,
): Effect.Effect<ReadonlyArray<AxiomLog>> =>
  runQuery(
    env,
    `['${env.AXIOM_DATASET_LOGS}'] | where ['attributes.custom']['canary.run_id'] == '${runId}' | project trace_id, event_name = tostring(['attributes.custom']['event.name']), event_kind = tostring(['attributes.custom']['event.kind']), event_source = tostring(['attributes.custom']['event.source']), service_name = ['service.name'], body = tostring(body), authorization = tostring(['attributes.custom']['authorization']), password = tostring(['attributes.custom']['password']), safe_message = tostring(['attributes.custom']['safe.message'])`,
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
