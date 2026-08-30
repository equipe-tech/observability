import {
  BrowserEvents,
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
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { initLogger, isEnabled, log } from "evlog";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeEvlogAdapter } from "../src/EvlogAdapter.ts";
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
        "job.amount": { classification: "public", required: false, metricLabel: false },
      },
    },
    failed: {
      name: "job.processing",
      kind: "defect",
      defaultSeverity: "error",
      mandatory: false,
      sampling: { kind: "always" },
      attributes: {
        "job.name": { classification: "public", required: true, metricLabel: false },
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

const startReceiver = async (responseDelayMillis = 0, status = 200) => {
  const bodies: Array<string> = [];
  const requestTimes: Array<number> = [];
  const server = createServer((request, response) => {
    requestTimes.push(Date.now());
    const chunks: Array<Uint8Array> = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      setTimeout(() => {
        response.writeHead(status, { "content-type": "application/json" });
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
    requestTimes,
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
            sink.recordBrowserBatch([
              {
                id: "browser-1",
                name: "job.completed",
                occurredAt: 1,
                attributes: { "job.name": "billing", "unknown.value": "blocked" },
                admission: { policyDroppedAttributes: 0 },
              },
            ]),
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
    expect(event["browser.event.occurred_at"]).toBe(1);
  });

  it("validates browser batches atomically before queue admission", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 10,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const sink = await observability.runtime.runPromise(
      TelemetryEventSink.pipe(Effect.provide(observability.eventLayer)),
    );
    const valid = {
      id: "atomic-valid",
      name: "job.completed",
      occurredAt: BrowserEvents.maxBrowserEventOccurredAt,
      attributes: { "job.name": "valid" },
      admission: { policyDroppedAttributes: 0 },
    };
    const invalidContract = {
      id: "atomic-invalid-contract",
      name: "job.completed",
      occurredAt: 1,
      attributes: {},
      admission: { policyDroppedAttributes: 0 },
    };
    const contractFailure = await Effect.runPromise(
      Effect.flip(sink.recordBrowserBatch([valid, invalidContract])),
    );
    expect(contractFailure.code).toBe("OBS_EVENT_MISSING_ATTRIBUTE");
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });

    const invalidTimestamp = {
      ...valid,
      id: "atomic-invalid-timestamp",
      occurredAt: BrowserEvents.maxBrowserEventOccurredAt + 1,
    };
    const timestampFailure = await Effect.runPromise(
      Effect.flip(sink.recordBrowserBatch([valid, invalidTimestamp])),
    );
    expect(timestampFailure.code).toBe("OBS_EVENT_INVALID_FIELD");
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });

    await Effect.runPromise(
      sink.recordBrowserBatch([
        { ...valid, id: "atomic-one", attributes: { "job.name": "atomic-one" } },
        { ...valid, id: "atomic-two", attributes: { "job.name": "atomic-two" } },
      ]),
    );
    await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    expect(wire).not.toContain("atomic-valid");
    expect(wire).not.toContain("atomic-invalid");
    const projected = receiver.bodies
      .filter((body) => body.includes('"resourceLogs"'))
      .flatMap((body) => {
        const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(body));
        return request.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) =>
            scope.logRecords.map((record) => JSON.parse(record.body.stringValue)),
          ),
        );
      });
    expect(projected.filter((event) => event["browser.event.id"] === "atomic-one")).toHaveLength(1);
    expect(projected.filter((event) => event["browser.event.id"] === "atomic-two")).toHaveLength(1);
  });

  it("returns every canonical contract rejection before admission", async () => {
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const adapter = evlogAdapter({ installGlobalLogger: false });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const sink = await observability.runtime.runPromise(
      TelemetryEventSink.pipe(Effect.provide(observability.eventLayer)),
    );
    const cases = [
      {
        name: "job.unknown",
        attributes: { "job.name": "billing" },
        code: "OBS_EVENT_UNKNOWN_NAME",
      },
      { name: "job.completed", attributes: {}, code: "OBS_EVENT_MISSING_ATTRIBUTE" },
      {
        name: "job.completed",
        attributes: { "job.name": "billing", "job.unknown": true },
        code: "OBS_EVENT_UNDECLARED_ATTRIBUTE",
      },
    ];
    for (const testCase of cases) {
      const failure = await Effect.runPromise(
        Effect.flip(
          sink.recordBrowserBatch([
            {
              id: crypto.randomUUID(),
              name: testCase.name,
              occurredAt: 1,
              attributes: testCase.attributes,
              admission: { policyDroppedAttributes: 0 },
            },
          ]),
        ),
      );
      expect(failure.code).toBe(testCase.code);
    }
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
    expect(adapter.drops().total).toBe(0);
    await observability.close();
  });

  it("preserves producer policy-drop metadata through adapter policy admission", async () => {
    const receiver = await startReceiver();
    const contract = await Effect.runPromise(defineTelemetryContract(contractDefinition));
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "evlog-test", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: receiver.endpoint },
        evlog: {
          contract,
          policy: {
            attributes: {
              "job.detail": {
                classification: "forbidden",
                required: false,
                metricLabel: false,
              },
            },
            blockedKeys: [],
            blockedValuePatterns: [],
          },
        },
        sentry: { enabled: false },
      }),
    );
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const receipt = await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "billing", "job.detail": "removed" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    expect(receipt.decision).toBe("recorded");
    if (receipt.decision !== "recorded") throw new Error("Expected a recorded event.");
    expect(receipt.admission.policyDroppedAttributes).toBe(1);
    await observability.close();
    await receiver.close();
    const body = receiver.bodies.find((candidate) => candidate.includes('"resourceLogs"')) ?? "";
    expect(body).not.toContain("removed");
    const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(body));
    const event = JSON.parse(
      request.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body.stringValue ?? "",
    );
    expect(event["event.policy_dropped_attributes"]).toBe(1);
    expect(adapter.drops().total).toBe(0);
  });

  it("applies policy at direct sink admission and preserves producer drop counts", async () => {
    const receiver = await startReceiver();
    const contract = await Effect.runPromise(defineTelemetryContract(contractDefinition));
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "evlog-test", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: receiver.endpoint },
        evlog: {
          contract,
          policy: {
            attributes: {
              "job.detail": {
                classification: "forbidden",
                required: false,
                metricLabel: false,
              },
            },
            blockedKeys: ["password"],
            blockedValuePatterns: ["secret-[0-9]+"],
          },
        },
        sentry: { enabled: false },
      }),
    );
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const receipt = await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "billing" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    if (receipt.decision !== "recorded") throw new Error("Expected a recorded event.");
    const sink = await observability.runtime.runPromise(
      TelemetryEventSink.pipe(Effect.provide(observability.eventLayer)),
    );
    const secrets = ["Bearer AAAABBBBCCCCDDDDEEEEFFFF", "secret-12345"];
    for (const secret of secrets) {
      await Effect.runPromise(
        sink.record(
          { ...receipt.event, attributes: { "job.name": "billing", "job.detail": secret } },
          { policyDroppedAttributes: 2 },
        ),
      );
    }
    await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    for (const secret of secrets) expect(wire).not.toContain(secret);
    expect(wire).not.toContain("job.detail");
    const projected = receiver.bodies
      .filter((body) => body.includes('"resourceLogs"'))
      .flatMap((body) => {
        const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(body));
        return request.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) =>
            scope.logRecords.map((record) => JSON.parse(record.body.stringValue)),
          ),
        );
      });
    expect(
      projected.filter((event) => event["event.policy_dropped_attributes"] === 3),
    ).toHaveLength(2);
    expect(JSON.stringify(adapter.drops())).not.toContain("Bearer");
  });

  it("preserves native global correlation and rejects malformed identifiers visibly", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ batchSize: 1, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    const traceId = "1".repeat(32);
    const spanId = "2".repeat(16);
    log.info({ "event.name": "job.completed", "job.name": "valid", traceId, spanId });
    log.info({
      "event.name": "job.completed",
      "job.name": "bad-trace",
      traceId: "A".repeat(32),
      spanId,
    });
    log.info({
      "event.name": "job.completed",
      "job.name": "bad-span",
      traceId,
      spanId: "2".repeat(15),
    });
    const report = await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    expect(wire).toContain(`"traceId":"${traceId}"`);
    expect(wire).toContain(`"spanId":"${spanId}"`);
    expect(wire).not.toContain("bad-trace");
    expect(wire).not.toContain("bad-span");
    expect(adapter.drops().reasons.contractRejected).toBe(2);
    expect(report.degraded).toBe(true);
  });

  it("projects structured errors and preserves upstream float string encoding", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const producer = makeEventProducer(contract);
    await observability.runtime.runPromise(
      producer
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "float", "job.amount": 42.5 },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.runtime.runPromise(
      producer
        .emit("failed", {
          error: { type: "PAYMENT_DECLINED", message: "Payment failed", retryable: false },
          attributes: { "job.name": "structured-error" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    expect(wire).toContain('"key":"job.amount","value":{"stringValue":"42.5"}');
    expect(wire).toContain('\\"error.type\\":\\"PAYMENT_DECLINED\\"');
    expect(wire).toContain('\\"error.name\\":\\"EvlogError\\"');
    expect(wire).toContain('\\"error.message\\":\\"Payment failed\\"');
    expect(wire).toContain('\\"error.status\\":500');
    expect(wire).toContain('\\"error.retryable\\":false');
    expect(wire).not.toContain("stack");
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

  it("flushes by batch interval before close", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 10,
      batchIntervalMillis: 20,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "interval" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(receiver.bodies.some((body) => body.includes("interval"))).toBe(true);
    await observability.close();
    await receiver.close();
  });

  it("uses retry delays, maximum attempts, and transport deadlines", async () => {
    const receiver = await startReceiver(50, 503);
    const { contract, config } = await makeConfig(receiver.endpoint);
    const lines: Array<string> = [];
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      maximumAttempts: 3,
      initialRetryDelayMillis: 10,
      maximumRetryDelayMillis: 15,
      transportTimeoutMillis: 5,
      transportRetries: 0,
      stdout: { write: (line) => lines.push(line) > 0 },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const startedAt = Date.now();
    await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "retry-exhausted" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    const elapsed = Date.now() - startedAt;
    await receiver.close();
    expect(receiver.requestTimes).toHaveLength(10);
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(adapter.drops().reasons.transport).toBe(1);
    expect(lines).toHaveLength(1);
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
  });

  it("counts post-close admission without requeueing", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const lines: Array<string> = [];
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      transportRetries: 0,
      stdout: { write: (line) => lines.push(line) > 0 },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const receipt = await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("completed", {
          outcome: "success",
          durationMs: 1,
          attributes: { "job.name": "before-close" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    if (receipt.decision !== "recorded") throw new Error("Expected a recorded event.");
    const sink = await observability.runtime.runPromise(
      TelemetryEventSink.pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await Effect.runPromise(sink.record(receipt.event, receipt.admission));
    await receiver.close();
    expect(adapter.drops().reasons.closed).toBe(1);
    expect(lines).toHaveLength(1);
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
    const drops = adapter.drops();
    expect(drops.reasons.stdoutUnavailable).toBe(1);
    expect(drops.total).toBe(
      Object.values(drops.reasons).reduce((total, count) => total + count, 0),
    );
    expect(report.degraded).toBe(true);
    expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
  });

  it("counts stdout exceptions as unavailable output", async () => {
    const { contract, config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      maximumBufferedBytes: 1,
      stdout: {
        write: () => {
          throw new Error("closed stdout");
        },
      },
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
    await observability.close();
    expect(adapter.drops().reasons.stdoutUnavailable).toBe(1);
  });

  it("rejects concurrent global logger ownership", async () => {
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const first = evlogAdapter();
    const second = evlogAdapter();
    const observability = await createNodeObservabilityFromConfig(config, [first.registration]);
    for (const registration of [first.registration, second.registration]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          Effect.tryPromise(() => createNodeObservabilityFromConfig(config, [registration])),
        ),
      );
      expect(JSON.stringify(failure)).toContain("OBS_EVLOG_LOGGER_CONFLICT");
    }
    await observability.close();
  });

  it("replaces a pre-existing logger and disables the owned logger on close", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const foreignEvents: Array<string> = [];
    initLogger({
      silent: true,
      drain: (context) => {
        foreignEvents.push(JSON.stringify(context.event));
      },
    });
    log.info({ "event.name": "job.completed", "job.name": "before-adapter" });
    expect(foreignEvents).toHaveLength(1);

    const adapter = evlogAdapter({ batchSize: 1, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    log.info({ "event.name": "job.completed", "job.name": "adapter-owned" });
    await observability.close();
    expect(isEnabled()).toBe(false);
    log.info({ "event.name": "job.completed", "job.name": "after-close" });
    await receiver.close();
    expect(foreignEvents).toHaveLength(1);
    expect(receiver.bodies.some((body) => body.includes("adapter-owned"))).toBe(true);
  });

  it("clears adapter ownership when global logger initialization throws", async () => {
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    let attempts = 0;
    const adapter = makeEvlogAdapter({}, (options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("logger initialization failed");
      initLogger(options);
    });
    await expect(
      createNodeObservabilityFromConfig(config, [adapter.registration]),
    ).rejects.toMatchObject({ code: "OBS_OBSERVABILITY_STARTUP_FAILED" });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    await observability.close();
    expect(attempts).toBe(3);
  });

  it("delivers public global logger events and permits a second generation", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    for (const name of ["first-generation", "second-generation"]) {
      const adapter = evlogAdapter({ batchSize: 1, transportRetries: 0 });
      const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
      log.info({ "event.name": "job.completed", "job.name": name });
      const report = await observability.close();
      expect(report.degraded).toBe(false);
    }
    await receiver.close();
    expect(receiver.bodies.some((body) => body.includes("first-generation"))).toBe(true);
    expect(receiver.bodies.some((body) => body.includes("second-generation"))).toBe(true);
  });

  it("reports invalid and unknown options through startup", async () => {
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const options = [
      { batchIntervalMillis: 0 },
      { maximumBufferedEvents: 1, batchSize: 2 },
      Object.assign({}, { maximumBufferedEvents: 1 }, { maximumBufferEvents: 1 }),
    ];
    for (const candidate of options) {
      const adapter = evlogAdapter(candidate);
      await expect(
        createNodeObservabilityFromConfig(config, [adapter.registration]),
      ).rejects.toMatchObject({
        code: "OBS_OBSERVABILITY_STARTUP_FAILED",
        cause: {
          cause: {
            code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
          },
        },
      });
    }
  });

  it("rejects request event names that are absent or not request contracts", async () => {
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    for (const requestEventName of ["job.completed", "request.unknown"]) {
      const adapter = evlogAdapter({ requestEventName });
      await expect(
        createNodeObservabilityFromConfig(config, [adapter.registration]),
      ).rejects.toMatchObject({ code: "OBS_OBSERVABILITY_STARTUP_FAILED" });
    }
  });

  it("counts invalid global events without exposing payloads", async () => {
    const { config } = await makeConfig(new URL("http://127.0.0.1:1"));
    const adapter = evlogAdapter({ batchSize: 1 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    log.info({ "job.name": "missing name" });
    log.info({ "event.name": "job.unknown", "job.name": "unknown name" });
    log.info({ "event.name": "job.completed", "job.detail": "missing required" });
    log.info({
      "event.name": "job.completed",
      "job.name": { invalid: true },
    });
    log.info({
      "event.name": "job.completed",
      "job.name": "billing",
      "job.unknown": "undeclared",
    });
    await observability.close();
    expect(adapter.drops().reasons.contractRejected).toBe(5);
    expect(adapter.drops().total).toBe(5);
    expect(Option.isSome(adapter.drops().firstDroppedAt)).toBe(true);
    expect(Option.isSome(adapter.drops().lastDroppedAt)).toBe(true);
    expect(JSON.stringify(adapter.drops())).not.toContain("missing required");
  });

  it("keeps TypeScript and Vite package mappings in parity", async () => {
    const tsconfig = Schema.decodeUnknownSync(
      Schema.Struct({
        compilerOptions: Schema.Struct({
          paths: Schema.Record(Schema.String, Schema.Array(Schema.String)),
        }),
      }),
    )(JSON.parse(await readFile(new URL("../../../tsconfig.json", import.meta.url), "utf8")));
    const vite = await readFile(new URL("../../../vite.config.ts", import.meta.url), "utf8");
    expect(tsconfig.compilerOptions.paths["@equipe-tech/observability-evlog"]).toEqual([
      "./packages/evlog/src/index.ts",
    ]);
    expect(vite).toContain('find: "@equipe-tech/observability-evlog"');
    expect(vite).toContain("packages/evlog/src/index.ts");
  });

  it("keeps contract delivery and preserves a replacement logger after detachment", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ batchSize: 1, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const replacementEvents: Array<string> = [];
    initLogger({
      silent: true,
      pretty: false,
      redact: false,
      env: { service: "replacement", environment: "replacement" },
      drain: (context) => {
        replacementEvents.push(JSON.stringify(context.event));
      },
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
    const report = await observability.close();
    log.info({ "event.name": "job.completed", "job.name": "foreign-after-close" });
    await receiver.close();
    expect(report.degraded).toBe(true);
    expect(adapter.drops().total).toBe(0);
    expect(receiver.bodies.some((body) => body.includes("after-replacement"))).toBe(true);
    expect(replacementEvents.some((event) => event.includes("foreign-after-close"))).toBe(true);
  });
});
