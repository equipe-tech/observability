import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { createServer, type Server } from "node:http";
import {
  decodeAxiomEnvironment,
  findChildSpan,
  findLogs,
  findMetric,
  findRootSpan,
  type AxiomEnvironment,
} from "./support/axiom.ts";

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

type RecordedQuery = {
  readonly path: string;
  readonly authorization: string;
  readonly query: string;
};

const AplQueryBody = Schema.Struct({ apl: Schema.String, startTime: Schema.String });
const MplQueryBody = Schema.Struct({
  mpl: Schema.String,
  startTime: Schema.String,
  endTime: Schema.String,
});
const decodeAplQueryBody = Schema.decodeUnknownOption(AplQueryBody);
const decodeMplQueryBody = Schema.decodeUnknownOption(MplQueryBody);

type StubAxiom = {
  readonly env: AxiomEnvironment;
  readonly queries: ReadonlyArray<RecordedQuery>;
  readonly server: Server;
};

const startStubAxiom = (
  matches: ReadonlyArray<{ readonly data: unknown }>,
  metricsResponse = "{}",
): Promise<StubAxiom> =>
  new Promise((resolve, reject) => {
    const queries: Array<RecordedQuery> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: string | Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed = Effect.runSync(
          Effect.try((): unknown => JSON.parse(body)).pipe(Effect.option),
        );
        const apl = parsed.pipe(
          Option.flatMap(decodeAplQueryBody),
          Option.map((query) => query.apl),
        );
        const mpl = parsed.pipe(
          Option.flatMap(decodeMplQueryBody),
          Option.map((query) => query.mpl),
        );
        queries.push({
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          query: Option.getOrElse(apl, () => Option.getOrElse(mpl, () => "")),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          request.url?.startsWith("/v1/query/_mpl") ? metricsResponse : JSON.stringify({ matches }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = decodeAddressInfo(server.address());
      if (Option.isNone(address)) {
        reject(new Error("The stub Axiom server did not report a port."));
        return;
      }
      const env = Effect.runSync(
        decodeAxiomEnvironment({
          AXIOM_URL: `http://127.0.0.1:${address.value.port}`,
          AXIOM_TOKEN: "stub-token",
          AXIOM_DATASET_TRACES: "e2e-traces",
          AXIOM_DATASET_LOGS: "e2e-logs",
          AXIOM_DATASET_METRICS: "e2e-metrics",
        }),
      );
      resolve({ env, queries, server });
    });
  });

describe("axiom query support", () => {
  it.live("queries root spans with the run id and decodes the projected row", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.promise(() =>
        startStubAxiom([
          {
            data: {
              trace_id: "trace-1",
              span_id: "span-1",
              parent_span_id: "",
              name: "canary.operation",
              service_name: "observability-canary",
              service_version: "0.1.0",
              environment_name: "e2e",
              environment_alias: "e2e",
            },
          },
        ]),
      );
      const root = yield* findRootSpan(stub.env, "test-run-1").pipe(
        Effect.ensuring(Effect.sync(() => stub.server.close())),
      );

      assert.isTrue(Option.isSome(root));
      const span = Option.getOrThrow(root);
      assert.strictEqual(span.traceId, "trace-1");
      assert.strictEqual(span.spanId, "span-1");
      assert.deepStrictEqual(span.parentSpanId, Option.none());
      assert.deepStrictEqual(span.serviceName, Option.some("observability-canary"));
      assert.deepStrictEqual(span.environmentName, Option.some("e2e"));
      assert.deepStrictEqual(span.environmentAlias, span.environmentName);

      const query = stub.queries[0];
      assert.isDefined(query);
      assert.strictEqual(query.path, "/v1/datasets/_apl?format=legacy");
      assert.strictEqual(query.authorization, "Bearer stub-token");
      assert.include(query.query, "['e2e-traces']");
      assert.include(query.query, "['attributes.custom']['canary.run_id'] == 'test-run-1'");
      assert.include(query.query, "name == 'canary.operation'");
      assert.include(
        query.query,
        "environment_name = tostring(['resource.custom']['deployment.environment.name'])",
      );
      assert.include(
        query.query,
        "environment_alias = tostring(['resource.custom']['deployment.environment'])",
      );
    }),
  );

  it.live("queries child spans by trace id and keeps the parent span id", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.promise(() =>
        startStubAxiom([
          {
            data: {
              trace_id: "trace-1",
              span_id: "span-2",
              parent_span_id: "span-1",
              name: "canary.child",
            },
          },
        ]),
      );
      const child = yield* findChildSpan(stub.env, "trace-1").pipe(
        Effect.ensuring(Effect.sync(() => stub.server.close())),
      );

      assert.isTrue(Option.isSome(child));
      assert.deepStrictEqual(Option.getOrThrow(child).parentSpanId, Option.some("span-1"));
      const query = stub.queries[0];
      assert.isDefined(query);
      assert.include(query.query, "trace_id == 'trace-1'");
      assert.include(query.query, "name == 'canary.child'");
    }),
  );

  it.live("decodes log rows and drops rows outside the projection contract", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.promise(() =>
        startStubAxiom([
          {
            data: {
              trace_id: "trace-1",
              event_name: "canary.completed",
              event_kind: "wide",
              event_source: null,
              service_name: "observability-canary",
              environment_name: "e2e",
              environment_alias: "e2e",
            },
          },
          { data: { unrelated: true } },
        ]),
      );
      const logs = yield* findLogs(stub.env, "test-run-1").pipe(
        Effect.ensuring(Effect.sync(() => stub.server.close())),
      );

      assert.strictEqual(logs.length, 1);
      const log = logs[0];
      assert.isDefined(log);
      assert.strictEqual(log.eventName, "canary.completed");
      assert.deepStrictEqual(log.traceId, Option.some("trace-1"));
      assert.deepStrictEqual(log.eventKind, Option.some("wide"));
      assert.deepStrictEqual(log.eventSource, Option.none());
      assert.deepStrictEqual(log.environmentName, Option.some("e2e"));
      assert.deepStrictEqual(log.environmentAlias, log.environmentName);
      const query = stub.queries[0];
      assert.isDefined(query);
      assert.include(query.query, "['e2e-logs']");
      assert.include(
        query.query,
        "environment_name = tostring(['resource.custom']['deployment.environment.name'])",
      );
      assert.include(
        query.query,
        "environment_alias = tostring(['resource.custom']['deployment.environment'])",
      );
    }),
  );

  it.live("queries the metrics dataset with MPL and returns the complete response", () =>
    Effect.gen(function* () {
      const metricsResponse = JSON.stringify({
        series: [
          {
            tags: {
              "canary.run_id": "test-run-1",
              accessToken: "****",
              tokenizer: "tokenizer-control",
            },
          },
        ],
      });
      const stub = yield* Effect.promise(() => startStubAxiom([], metricsResponse));
      const metric = yield* findMetric(
        stub.env,
        "test-run-1",
        "e2e",
        "observability-canary",
        "0.1.0",
      ).pipe(Effect.ensuring(Effect.sync(() => stub.server.close())));

      assert.isTrue(Option.isSome(metric));
      assert.include(Option.getOrThrow(metric).content, "tokenizer-control");
      const query = stub.queries[0];
      assert.isDefined(query);
      assert.strictEqual(query.path, "/v1/query/_mpl?format=metrics-v2");
      assert.include(query.query, "`e2e-metrics`:`canary.operations`");
      assert.include(query.query, '`canary.run_id` == "test-run-1"');
      assert.include(query.query, '`service.namespace` == "equipe-tech"');
      assert.include(query.query, '`service.name` == "observability-canary"');
      assert.include(query.query, '`service.version` == "0.1.0"');
      assert.include(query.query, '`deployment.environment.name` == "e2e"');
      assert.include(query.query, '`deployment.environment` == "e2e"');
    }),
  );
});
