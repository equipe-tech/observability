import {
  Contract,
  CorrelationContext,
  makeEventProducer,
  parseRequestId,
  parseRunId,
  parseSpanId,
  parseTraceId,
  TelemetryEventSink,
} from "@equipe-tech/observability";
import {
  createNodeObservabilityFromConfig,
  ingestBrowserEvents,
} from "@equipe-tech/observability/node";
import { defineTelemetryContract, parseNodeObservabilityConfig } from "@equipe-tech/observability";
import { createServer } from "node:http";
import { getEnvironment, initLogger } from "evlog";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { evlogAdapter } from "../src/index.ts";

const contractDefinition = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    completed: {
      name: "job.completed",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {
        "job.name": { classification: "public", required: true, metricLabel: false },
        "job.detail": { classification: "internal", required: false, metricLabel: false },
      },
    },
  },
  metrics: {},
  auditActions: {},
});

const RequestBody = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({
        attributes: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
          }),
        ),
      }),
      scopeLogs: Schema.Array(
        Schema.Struct({
          scope: Schema.Struct({ name: Schema.String }),
          logRecords: Schema.Array(
            Schema.Struct({
              severityText: Schema.String,
              body: Schema.Struct({ stringValue: Schema.String }),
              traceId: Schema.optional(Schema.String),
              spanId: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});

const makeConfig = async (endpoint: URL) => {
  const contract = await Effect.runPromise(defineTelemetryContract(contractDefinition));
  const config = await Effect.runPromise(
    parseNodeObservabilityConfig({
      enabled: true,
      profile: "worker",
      service: { name: "evlog-test", version: "1.2.3", environment: "test" },
      telemetry: { endpoint },
      evlog: { contract, policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] } },
      sentry: { enabled: false },
    }),
  );
  return { contract, config };
};

const startReceiver = async (responseDelayMillis = 0) => {
  const bodies: Array<string> = [];
  const server = createServer((request, response) => {
    const chunks: Array<Uint8Array> = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }, responseDelayMillis);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = Schema.decodeUnknownSync(
    Schema.Struct({ address: Schema.String, family: Schema.String, port: Schema.Number }),
  )(server.address());
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}`),
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("evlogAdapter", () => {
  it("exports contract events through the real evlog OTLP encoder", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const traceId = await Effect.runPromise(parseTraceId("1".repeat(32)));
    const spanId = await Effect.runPromise(parseSpanId("2".repeat(16)));
    const requestId = await Effect.runPromise(parseRequestId("request-1"));
    const runId = await Effect.runPromise(parseRunId("run-1"));
    const producer = makeEventProducer(contract);
    const secret = `Bearer ${crypto.randomUUID().replaceAll("-", "")}`;
    await observability.runtime.runPromise(
      producer
        .emit("completed", {
          severity: "fatal",
          outcome: "success",
          durationMs: 8,
          correlation: new CorrelationContext({
            trace: { _tag: "Traced", traceId, spanId },
            requestId: Option.some(requestId),
            runId: Option.some(runId),
          }),
          attributes: { "job.name": "billing", "job.detail": secret },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await receiver.close();
    const logBody = receiver.bodies.find((body) => body.includes('"resourceLogs"')) ?? "";
    expect(logBody).not.toContain(secret);
    const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(logBody));
    const resource = request.resourceLogs[0];
    const scope = resource?.scopeLogs[0];
    const record = scope?.logRecords[0];
    expect(scope?.scope.name).toBe("evlog");
    expect(record?.severityText).toBe("ERROR");
    expect(record?.traceId).toBe(traceId);
    expect(record?.spanId).toBe(spanId);
    const body = JSON.parse(record?.body.stringValue ?? "");
    expect(body["event.name"]).toBe("job.completed");
    expect(body["event.severity"]).toBe("fatal");
    expect(body["event.policy_dropped_attributes"]).toBe(0);
    const resources = new Map(
      resource?.resource.attributes.map((attribute) => [
        attribute.key,
        attribute.value.stringValue,
      ]),
    );
    expect(resources.get("service.namespace")).toBe("equipe-tech");
    expect(resources.get("service.name")).toBe("evlog-test");
    expect(resources.get("service.version")).toBe("1.2.3");
    expect(resources.get("deployment.environment.name")).toBe("test");
    expect(resources.get("deployment.environment")).toBe("test");
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
  });

  it("rejects unknown attributes before queue and transport", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const failure = await observability.runtime.runPromise(
      Effect.flip(
        TelemetryEventSink.pipe(
          Effect.flatMap((sink) =>
            sink.recordBrowser({
              id: "browser-1",
              name: "job.completed",
              occurredAt: 1,
              attributes: { "job.name": "billing", "unknown.value": "blocked" },
              policyDroppedAttributes: 0,
            }),
          ),
          Effect.provide(observability.eventLayer),
        ),
      ),
    );
    expect(failure.code).toBe("OBS_EVENT_UNDECLARED_ATTRIBUTE");
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
    await observability.close();
    await receiver.close();
    expect(receiver.bodies.some((body) => body.includes('"resourceLogs"'))).toBe(false);
  });

  it("routes browser HTTP ingest through the adapter pipeline", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    await observability.runtime.runPromise(
      ingestBrowserEvents({
        version: 1,
        events: [
          {
            id: "browser-1",
            name: "job.completed",
            occurredAt: 1,
            fields: { "job.name": "browser" },
          },
        ],
      }).pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await receiver.close();
    const body = receiver.bodies.find((candidate) => candidate.includes('"resourceLogs"')) ?? "";
    const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(body));
    const event = JSON.parse(
      request.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body.stringValue ?? "",
    );
    expect(event["event.source"]).toBe("browser");
    expect(event["browser.event.id"]).toBe("browser-1");
  });

  it("separates byte overflow from count overflow and balances bytes", async () => {
    const { contract, config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const secret = `Bearer ${crypto.randomUUID().replaceAll("-", "")}`;
    const lines: Array<string> = [];
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      maximumBufferedBytes: 400,
      maximumBufferedEvents: 1,
      batchSize: 1,
      maximumAttempts: 1,
      transportRetries: 0,
      stdout: { write: (line) => lines.push(line) > 0 },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const producer = makeEventProducer(contract);
    await observability.runtime.runPromise(
      producer
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: {
            "job.name": "billing",
            "job.detail": `${"x".repeat(300)} ${secret}`,
          },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    expect(adapter.drops().reasons.byteOverflow).toBe(1);
    expect(adapter.drops().total).toBe(
      Object.values(adapter.drops().reasons).reduce((total, count) => total + count, 0),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
    expect(JSON.stringify(adapter.drops())).not.toContain(secret);
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
  });

  it("drops the oldest buffered event at the upstream count limit", async () => {
    const receiver = await startReceiver(50);
    const { contract, config } = await makeConfig(receiver.endpoint);
    const lines: Array<string> = [];
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      maximumBufferedEvents: 1,
      maximumBufferedBytes: 100_000,
      batchSize: 1,
      transportRetries: 0,
      stdout: { write: (line) => lines.push(line) > 0 },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const producer = makeEventProducer(contract);
    for (const name of ["first", "second", "third"]) {
      await observability.runtime.runPromise(
        producer
          .emit("completed", {
            outcome: "success",
            durationMs: 1,
            attributes: { "job.name": name },
          })
          .pipe(Effect.provide(observability.eventLayer)),
      );
    }
    await observability.close();
    await receiver.close();
    expect(adapter.drops().reasons.countOverflow).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("second");
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
  });

  it("counts stdout backpressure as unrecoverable loss", async () => {
    const { contract, config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      maximumBufferedBytes: 1,
      stdout: { write: () => false },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "billing" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    const report = await observability.close();
    expect(adapter.drops().reasons.stdoutUnavailable).toBe(1);
    expect(report.degraded).toBe(true);
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
  });

  it("rejects a foreign global logger before startup", async () => {
    const initial = { ...getEnvironment() };
    initLogger({
      silent: true,
      pretty: false,
      redact: false,
      env: { service: "foreign", environment: "foreign" },
    });
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const adapter = evlogAdapter();
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.tryPromise(() => createNodeObservabilityFromConfig(config, [adapter.registration])),
      ),
    );
    expect(JSON.stringify(failure)).toContain("OBS_EVLOG_LOGGER_CONFLICT");
    initLogger({
      silent: true,
      pretty: false,
      redact: false,
      env: initial,
    });
  });

  it("keeps contract delivery after global logger replacement", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ batchSize: 1, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    initLogger({
      silent: true,
      pretty: false,
      redact: false,
      env: { service: "replacement", environment: "replacement" },
    });
    await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "after-replacement" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await receiver.close();
    expect(adapter.drops().reasons.loggerDetached).toBe(1);
    expect(receiver.bodies.some((body) => body.includes("after-replacement"))).toBe(true);
  });
});
