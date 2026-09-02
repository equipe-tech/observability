import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  decodeAxiomEnvironment,
  deployedCanaryPollingBudget,
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
  readonly organizationId: string;
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
const productionCollectorConfig = await readFile(
  new URL("../../cli/src/assets/production.yaml", import.meta.url),
  "utf8",
);

type StubAxiom = {
  readonly env: AxiomEnvironment;
  readonly queries: ReadonlyArray<RecordedQuery>;
  readonly server: Server;
};

type StubAxiomResponse = {
  readonly aplBody?: string;
  readonly aplStatus?: number;
};

const startStubAxiom = (
  matches: ReadonlyArray<{ readonly data: unknown }>,
  metricsResponse = "{}",
  responseOptions: StubAxiomResponse = {},
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
          organizationId: request.headers["x-axiom-org-id"]?.toString() ?? "",
          query: Option.getOrElse(apl, () => Option.getOrElse(mpl, () => "")),
        });
        const metricsRequest = request.url?.startsWith("/v1/query/_mpl") ?? false;
        response.writeHead(metricsRequest ? 200 : (responseOptions.aplStatus ?? 200), {
          "content-type": "application/json",
        });
        response.end(
          metricsRequest
            ? metricsResponse
            : (responseOptions.aplBody ?? JSON.stringify({ matches })),
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
          AXIOM_READ_TOKEN: "stub-read-token",
          AXIOM_ORGANIZATION_ID: "stub-organization",
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
      const root = yield* findRootSpan(stub.env, "test-run-1", "0.1.0").pipe(
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
      assert.strictEqual(query.authorization, "Bearer stub-read-token");
      assert.strictEqual(query.organizationId, "stub-organization");
      assert.include(query.query, "['e2e-traces']");
      assert.include(query.query, "['attributes.custom']['canary.run_id'] == 'test-run-1'");
      assert.include(query.query, "['resource.custom']['service.version'] == '0.1.0'");
      assert.include(query.query, "name == 'canary.operation'");
      assert.include(query.query, "service_name = tostring(['resource.custom']['service.name'])");
      assert.include(
        query.query,
        "service_version = tostring(['resource.custom']['service.version'])",
      );
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
              service_version: "0.1.0",
              environment_name: "e2e",
              environment_alias: "e2e",
            },
          },
          { data: { unrelated: true } },
        ]),
      );
      const logs = yield* findLogs(stub.env, "test-run-1", "0.1.0").pipe(
        Effect.ensuring(Effect.sync(() => stub.server.close())),
      );

      assert.strictEqual(logs.length, 1);
      const log = logs[0];
      assert.isDefined(log);
      assert.strictEqual(log.eventName, "canary.completed");
      assert.deepStrictEqual(log.traceId, Option.some("trace-1"));
      assert.deepStrictEqual(log.eventKind, Option.some("wide"));
      assert.deepStrictEqual(log.eventSource, Option.none());
      assert.deepStrictEqual(log.serviceVersion, Option.some("0.1.0"));
      assert.deepStrictEqual(log.environmentName, Option.some("e2e"));
      assert.deepStrictEqual(log.environmentAlias, log.environmentName);
      const query = stub.queries[0];
      assert.isDefined(query);
      assert.include(query.query, "['e2e-logs']");
      const serviceResourceFields = ["service.namespace", "service.name", "service.version"];
      for (const field of serviceResourceFields) {
        assert.include(query.query, `['resource.custom']['${field}']`);
      }
      assert.notInclude(query.query, "service_name = ['service.name']");
      assert.notInclude(query.query, "and ['service.version'] ==");
      assert.include(productionCollectorConfig, "otlphttp/logs:");
      assert.include(productionCollectorConfig, "X-Axiom-Dataset: ${env:AXIOM_DATASET_LOGS}");
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

  it.live("observes a non-JSON provider response before decoding", () =>
    Effect.gen(function* () {
      const observed: Array<string> = [];
      const stub = yield* Effect.promise(() =>
        startStubAxiom([], "{}", { aplBody: "gateway unavailable", aplStatus: 502 }),
      );
      yield* findRootSpan(stub.env, "test-run-1", "0.1.0", {
        observe: (response) => Effect.sync(() => observed.push(response)),
      }).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => stub.server.close())));
      assert.deepStrictEqual(observed, ["status=502 body=gateway unavailable"]);
    }),
  );

  it("keeps the polling worst case below the suite timeout", () => {
    const queryBudget =
      deployedCanaryPollingBudget.attempts *
      deployedCanaryPollingBudget.queriesPerAttempt *
      deployedCanaryPollingBudget.queryTimeoutMilliseconds;
    const sleepBudget =
      (deployedCanaryPollingBudget.attempts - 1) * deployedCanaryPollingBudget.sleepMilliseconds;
    assert.isBelow(queryBudget + sleepBudget, deployedCanaryPollingBudget.suiteTimeoutMilliseconds);
  });

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
      assert.strictEqual(query.authorization, "Bearer stub-read-token");
      assert.strictEqual(query.organizationId, "stub-organization");
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
