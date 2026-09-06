import { Effect, Schema } from "effect";
import {
  axiomAplQueryUrl,
  decodeAxiomEnvironment,
} from "../packages/telemetry/test/support/axiom.ts";

const AxiomSchemaErrorCode = Schema.Literals([
  "OBS_AXIOM_SCHEMA_INPUT_INVALID",
  "OBS_AXIOM_SCHEMA_REQUEST_FAILED",
  "OBS_AXIOM_SCHEMA_RESPONSE_INVALID",
]);

export class AxiomSchemaError extends Schema.TaggedError<AxiomSchemaError>()("AxiomSchemaError", {
  code: AxiomSchemaErrorCode,
  message: Schema.String,
  correlationId: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

const DatasetSchemaResponse = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      data: Schema.Struct({
        ColumnName: Schema.NonEmptyString,
        ColumnType: Schema.NonEmptyString,
      }),
    }),
  ).check(Schema.isMaxLength(512)),
});

const decodeDatasetSchemaResponse = Schema.decodeUnknownEffect(DatasetSchemaResponse);

type DatasetSchema = {
  readonly signal: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: string }>;
};

export const inspectAxiomSchema = Effect.fn("inspectAxiomSchema")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const correlationId = crypto.randomUUID();
  const failure = (
    code: typeof AxiomSchemaErrorCode.Type,
    message: string,
    cause: unknown,
  ): AxiomSchemaError => new AxiomSchemaError({ code, message, correlationId, cause });
  const env = yield* decodeAxiomEnvironment(environment).pipe(
    Effect.mapError((cause) =>
      failure(
        "OBS_AXIOM_SCHEMA_INPUT_INVALID",
        "Configure the Axiom read environment before retrying.",
        cause,
      ),
    ),
  );
  const url = yield* Effect.try({
    try: () => axiomAplQueryUrl(env.AXIOM_URL),
    catch: (cause) =>
      failure(
        "OBS_AXIOM_SCHEMA_INPUT_INVALID",
        "Configure a valid Axiom URL before retrying.",
        cause,
      ),
  });
  const results: Array<DatasetSchema> = [];
  for (const dataset of [
    { signal: "traces", name: env.AXIOM_DATASET_TRACES },
    { signal: "logs", name: env.AXIOM_DATASET_LOGS },
  ]) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.AXIOM_READ_TOKEN}`,
            "content-type": "application/json",
            "x-axiom-org-id": env.AXIOM_ORGANIZATION_ID,
          },
          body: JSON.stringify({ apl: `[${JSON.stringify(dataset.name)}] | getschema` }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      catch: (cause) =>
        failure(
          "OBS_AXIOM_SCHEMA_REQUEST_FAILED",
          "The Axiom schema request failed. Check connectivity before retrying.",
          cause,
        ),
    });
    if (!response.ok) {
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
      return yield* failure(
        "OBS_AXIOM_SCHEMA_REQUEST_FAILED",
        `Axiom schema lookup returned HTTP ${response.status}. Check read access and the dataset configuration before retrying.`,
        response.status,
      );
    }
    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        failure(
          "OBS_AXIOM_SCHEMA_RESPONSE_INVALID",
          "Axiom returned invalid schema JSON. Check provider compatibility before retrying.",
          cause,
        ),
    });
    const schema = yield* decodeDatasetSchemaResponse(payload).pipe(
      Effect.mapError((cause) =>
        failure(
          "OBS_AXIOM_SCHEMA_RESPONSE_INVALID",
          "Axiom returned unsupported schema metadata. Check provider compatibility before retrying.",
          cause,
        ),
      ),
    );
    results.push({
      signal: dataset.signal,
      fields: schema.matches.map(({ data }) => ({ name: data.ColumnName, type: data.ColumnType })),
    });
  }
  return results;
});

if (import.meta.main) {
  Effect.runPromise(inspectAxiomSchema(process.env)).then(
    (schemas) => console.log(JSON.stringify(schemas)),
    (cause) => {
      if (cause instanceof AxiomSchemaError) {
        console.error(`${cause.code}: ${cause.message} Correlation ID: ${cause.correlationId}.`);
      } else {
        console.error(
          "Axiom schema inspection failed unexpectedly. Review the diagnostic implementation before retrying.",
        );
      }
      process.exitCode = 1;
    },
  );
}
