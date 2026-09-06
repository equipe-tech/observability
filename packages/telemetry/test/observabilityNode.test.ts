import { Effect, Layer, Metric, Option, Predicate, Schema } from "effect";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { defineTelemetryContract, makeMetricProducer, TelemetryEventSink } from "../src/index.ts";
import { AdapterName, registerTestingAdapter } from "../src/profile/ObservabilityAdapter.ts";
import { parseNodeObservabilityConfig } from "../src/profile/ObservabilityConfig.ts";
import type { DataPolicyInput } from "../src/profile/DataPolicy.ts";
import { createTestingNodeObservabilityFromConfig } from "../src/node/Observability.ts";

const OtlpMetric = Schema.Struct({
  name: Schema.String,
  sum: Schema.Struct({
    dataPoints: Schema.Array(
      Schema.Struct({
        attributes: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Struct({ stringValue: Schema.String }),
          }),
        ),
        asDouble: Schema.Number,
      }),
    ),
  }).pipe(Schema.optionalKey),
});
const OtlpPayload = Schema.Struct({
  resourceMetrics: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({
        attributes: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Struct({ stringValue: Schema.String }),
          }),
        ),
      }),
      scopeMetrics: Schema.Array(Schema.Struct({ metrics: Schema.Array(OtlpMetric) })),
    }),
  ),
});
const parseOtlpPayload = Schema.decodeUnknownSync(OtlpPayload);

const contract = await Effect.runPromise(
  defineTelemetryContract({
    version: 1,
    events: {},
    metrics: {
      WorkerFacade: {
        name: "worker.facade",
        description: "Worker facade",
        unit: "1",
        kind: "counter",
        attributes: {
          "worker.queue": {
            classification: "internal",
            maximumCardinality: 2,
            allowedValues: ["primary", "secondary"],
          },
        },
      },
    },
    auditActions: {},
  }),
);
const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };
const events = registerTestingAdapter({
  name: AdapterName.make("events"),
  capability: "events",
  stage: "server",
  start: () =>
    Effect.succeed({
      flush: Effect.void,
      close: Effect.void,
      eventLayer: Option.some(
        Layer.succeed(
          TelemetryEventSink,
          TelemetryEventSink.of({
            record: () => Effect.void,
            admitBrowserBatch: () => Effect.succeed({ commit: Effect.void }),
          }),
        ),
      ),
      degraded: () => false,
    }),
});

const config = (endpoint: URL, enabled = true, dataPolicy: DataPolicyInput = policy) =>
  Effect.runPromise(
    parseNodeObservabilityConfig({
      enabled,
      profile: "worker",
      service: { name: "worker-e2e", version: "1.4.0", environment: "test" },
      telemetry: { endpoint },
      evlog: { contract, policy: dataPolicy },
      sentry: { enabled: false },
    }),
  );

const metricNamed = (payload: typeof OtlpPayload.Type, name: string) =>
  payload.resourceMetrics
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.name === name);

const resourceValues = (payload: typeof OtlpPayload.Type, key: string) =>
  payload.resourceMetrics.flatMap((entry) =>
    entry.resource.attributes
      .filter((attribute) => attribute.key === key)
      .map((attribute) => attribute.value.stringValue),
  );

const policyCases = [
  {
    name: "default",
    policy,
    expectedVersion: "1.4.0",
  },
  {
    name: "sensitive service version",
    policy: {
      attributes: {
        "service.version": {
          classification: "sensitive",
          required: false,
          metricLabel: false,
        },
      },
      blockedKeys: [],
      blockedValuePatterns: [],
    },
    expectedVersion: "****",
  },
  {
    name: "blocked service version key",
    policy: {
      attributes: {},
      blockedKeys: ["^service\\.version$"],
      blockedValuePatterns: [],
    },
    expectedVersion: "****",
  },
  {
    name: "blocked service version value",
    policy: {
      attributes: {},
      blockedKeys: [],
      blockedValuePatterns: ["1\\.4\\.0"],
    },
    expectedVersion: "[REDACTED]",
  },
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly policy: DataPolicyInput;
  readonly expectedVersion: string;
}>;

describe("Node observability boundary", () => {
  it("exports contract producer metrics through the shared worker runtime", async () => {
    const paths: Array<string> = [];
    const metricPayloads: Array<typeof OtlpPayload.Type> = [];
    const server = createServer((request, response) => {
      if (request.url !== undefined) paths.push(request.url);
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("/v1/metrics") === true) {
          metricPayloads.push(parseOtlpPayload(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || Predicate.isString(address)) {
      throw new Error("Expected a TCP server address.");
    }
    const parsed = await config(new URL(`http://127.0.0.1:${address.port}`));
    const handle = await createTestingNodeObservabilityFromConfig(parsed, [events]);
    if (!handle.enabled) throw new Error("Expected enabled observability.");
    makeMetricProducer(contract, handle.metrics)
      .counter("WorkerFacade")
      .add(3, { "worker.queue": "primary" });
    const runtimeCounter = Metric.counter("worker.runtime");
    await handle.runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("worker completed");
        yield* Metric.update(runtimeCounter, 1);
      }).pipe(Effect.withSpan("worker.run")),
    );
    const report = await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(report.durationMillis).toBeLessThanOrEqual(5_000);
    expect(paths.some((path) => path.endsWith("/v1/logs"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/v1/traces"))).toBe(true);
    const facadePayloads = metricPayloads.filter(
      (payload) => metricNamed(payload, "worker.facade") !== undefined,
    );
    expect(facadePayloads.length).toBeGreaterThan(0);
    expect(
      facadePayloads.every((payload) => metricNamed(payload, "worker.runtime") !== undefined),
    ).toBe(true);
    const sharedPayload = facadePayloads[0];
    if (sharedPayload === undefined) throw new Error("Expected a shared metric payload.");
    const facadeMetric = metricNamed(sharedPayload, "worker.facade");
    expect(facadeMetric).toEqual({
      name: "worker.facade",
      sum: {
        dataPoints: [
          {
            attributes: [{ key: "worker.queue", value: { stringValue: "primary" } }],
            asDouble: 3,
          },
        ],
      },
    });
    expect(metricNamed(sharedPayload, "worker.runtime")).toBeDefined();
  });

  it.each(policyCases)(
    "exports $name facade metrics from one transformed runtime",
    async (testCase) => {
      const metricPayloads: Array<typeof OtlpPayload.Type> = [];
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url?.endsWith("/v1/metrics") === true) {
            metricPayloads.push(
              parseOtlpPayload(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
            );
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || Predicate.isString(address)) {
        throw new Error("Expected a TCP server address.");
      }
      const parsed = await config(
        new URL(`http://127.0.0.1:${address.port}`),
        true,
        testCase.policy,
      );
      const handle = await createTestingNodeObservabilityFromConfig(parsed, [events]);
      if (!handle.enabled) throw new Error("Expected enabled observability.");
      makeMetricProducer(contract, handle.metrics)
        .counter("WorkerFacade")
        .add(1, { "worker.queue": "primary" });
      await handle.runtime.runPromise(Metric.update(Metric.counter("worker.runtime"), 1));
      await handle.flush();
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const facadePayloads = metricPayloads.filter(
        (payload) => metricNamed(payload, "worker.facade") !== undefined,
      );
      expect(facadePayloads.length).toBeGreaterThan(0);
      expect(
        facadePayloads.every((payload) => metricNamed(payload, "worker.runtime") !== undefined),
      ).toBe(true);
      expect(
        facadePayloads.flatMap((payload) => resourceValues(payload, "service.version")),
      ).toEqual(Array.from({ length: facadePayloads.length }, () => testCase.expectedVersion));
      expect(JSON.stringify(metricPayloads)).not.toContain(
        testCase.expectedVersion === "1.4.0" ? "raw-version-never-present" : "1.4.0",
      );
    },
  );

  it("keeps disabled handles inert and exports nothing", async () => {
    const parsed = await config(new URL("http://127.0.0.1:1"), false);
    const handle = await createTestingNodeObservabilityFromConfig(parsed, [events]);
    expect(handle.enabled).toBe(false);
    makeMetricProducer(contract, handle.metrics)
      .counter("WorkerFacade")
      .add(1, { "worker.queue": "primary" });
    await handle.flush();
    await handle.close();
  });

  it("does not block application work when the Collector is unavailable", async () => {
    const parsed = await config(new URL("http://127.0.0.1:1"));
    const handle = await createTestingNodeObservabilityFromConfig(parsed, [events]);
    if (!handle.enabled) throw new Error("Expected enabled observability.");
    let completed = false;
    await handle.runtime.runPromise(
      Effect.sync(() => {
        completed = true;
      }),
    );
    const report = await handle.close();
    expect(completed).toBe(true);
    expect(report.durationMillis).toBeLessThanOrEqual(5_000);
  });
});
