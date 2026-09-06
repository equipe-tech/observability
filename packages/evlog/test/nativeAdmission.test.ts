import {
  Contract,
  defineTelemetryContract,
  makeEventProducer,
  parseNodeObservabilityConfig,
} from "@equipe-tech/observability";
import { makeNodeObservability } from "@equipe-tech/observability/node";
import { Effect, Random, Schema } from "effect";
import { createRequestLogger, log } from "evlog";
import { createServer } from "node:http";
import { expect, it } from "vite-plus/test";
import { evlogAdapter } from "../src/index.ts";

const attributes = {
  "case.id": { classification: "public", required: true, metricLabel: false },
  "job.detail": { classification: "sensitive", required: false, metricLabel: false },
  "job.private": { classification: "forbidden", required: false, metricLabel: false },
} satisfies Contract.AttributeDefinitionsInput;
const definition = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    operation: {
      name: "job.completed",
      kind: "operation",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes,
    },
    domain: {
      name: "job.changed",
      kind: "domain",
      defaultSeverity: "info",
      mandatory: false,
      sampling: { kind: "rate", rate: 0.25 },
      attributes,
    },
    request: {
      name: "http.completed",
      kind: "request",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes,
    },
    defect: {
      name: "boundary.defect",
      kind: "defect",
      defaultSeverity: "error",
      mandatory: false,
      sampling: { kind: "rate", rate: 0.25 },
      attributes,
    },
    audit: {
      name: "audit.custom",
      kind: "audit",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes,
    },
  },
  metrics: {},
  auditActions: {},
});
const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));
const decodeBody = Schema.decodeUnknownSync(
  Schema.Struct({
    resourceLogs: Schema.Array(
      Schema.Struct({
        scopeLogs: Schema.Array(
          Schema.Struct({
            logRecords: Schema.Array(
              Schema.Struct({ body: Schema.Struct({ stringValue: Schema.String }) }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const decodeFields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

it.each([200, 503])(
  "uses canonical native admission before OTLP and fallback with receiver status %s",
  async (status) => {
    const bodies: Array<string> = [];
    const fallback: Array<string> = [];
    const server = createServer((request, response) => {
      const chunks: Array<Uint8Array> = [];
      request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url === "/v1/logs") bodies.push(Buffer.concat(chunks).toString());
        response.writeHead(request.url === "/v1/logs" ? status : 200, {
          "content-type": "application/json",
        });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const contract = await Effect.runPromise(defineTelemetryContract(definition));
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "native-admission", version: "1.0.0", environment: "test" },
        telemetry: {
          endpoint: new URL(`http://127.0.0.1:${decodeAddress(server.address()).port}`),
        },
        evlog: { contract, policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] } },
        sentry: { enabled: false },
      }),
    );
    const adapter = evlogAdapter({
      requestEventName: "http.completed",
      maximumAttempts: 1,
      transportRetries: 0,
      stdout: { write: (line) => fallback.push(line) > 0 },
    });
    const handle = await Effect.runPromise(
      makeNodeObservability(config, [adapter.registration]).pipe(
        Effect.provideService(Random.Random, {
          nextIntUnsafe: () => 1,
          nextDoubleUnsafe: () => 0.5,
        }),
      ),
    );
    if (!handle.enabled) throw new Error("Expected enabled observability.");
    try {
      const producer = makeEventProducer(contract);
      await handle.runtime.runPromise(
        producer
          .emit("operation", {
            outcome: "success",
            durationMs: 1,
            attributes: { "case.id": "producer", "job.detail": "private-business-value" },
          })
          .pipe(Effect.provide(handle.eventLayer)),
      );
      const rejected = await handle.runtime.runPromise(
        producer
          .emit("operation", {
            outcome: "success",
            durationMs: 1,
            attributes: {
              "case.id": "producer-forbidden",
              "job.private": "forbidden-business-value",
            },
          })
          .pipe(Effect.provide(handle.eventLayer), Effect.flip),
      );
      expect(rejected.code).toBe("OBS_EVENT_RESTRICTED_ATTRIBUTE");
      log.info({
        "event.name": "job.completed",
        outcome: "success",
        durationMs: 2,
        "case.id": "native",
        "job.detail": "private-business-value",
      });
      log.error({
        "event.name": "boundary.defect",
        "case.id": "defect",
        error: { type: "JOB_FAILED", message: "A safe failure", retryable: true },
      });
      log.info({ "event.name": "job.changed", outcome: "success", "case.id": "sampled" });
      log.info({ "event.name": "job.changed", outcome: "failure", "case.id": "domain-failure" });
      const request = createRequestLogger({
        method: "GET",
        path: "/jobs",
        requestId: "native-request",
      });
      request.set({ status: 503, "case.id": "request" });
      request.error(new Error("private-business-value"));
      request.emit();
      const invalid = [
        {
          "event.name": "job.completed",
          outcome: "success",
          durationMs: 1,
          "job.private": "forbidden-business-value",
        },
        { "event.name": "job.completed", outcome: "success" },
        { "event.name": "job.completed", durationMs: 1 },
        { "event.name": "job.completed", outcome: "success", durationMs: -1 },
        { "event.name": "job.completed", outcome: "denied", durationMs: 1 },
        { "event.name": "job.changed" },
        { "event.name": "boundary.defect" },
        { "event.name": "boundary.defect", error: { type: "JOB_FAILED", message: "safe" } },
        {
          "event.name": "boundary.defect",
          outcome: "success",
          error: { type: "JOB_FAILED", message: "safe", retryable: false },
        },
        { "event.name": "http.completed", status: 200, durationMs: 1 },
        {
          "event.name": "http.completed",
          status: 600,
          durationMs: 1,
          method: "GET",
          path: "/jobs",
        },
        { "event.name": "audit.custom", outcome: "success" },
        { "event.name": "audit.custom", audit: { action: "undeclared" } },
        {
          "event.name": "job.completed",
          outcome: "success",
          durationMs: 1,
          traceId: "1".repeat(32),
        },
      ];
      for (const event of invalid) log.error({ ...event, "case.id": "invalid" });
      expect(adapter.drops().reasons.contractRejected).toBe(invalid.length);
      await handle.close();
      const wire = bodies.join("\n");
      for (const output of [wire, fallback.join("\n")]) {
        expect(output).not.toContain("private-business-value");
        expect(output).not.toContain("forbidden-business-value");
        expect(output).not.toContain('"case.id":"invalid"');
        expect(output).not.toContain('"case.id":"sampled"');
      }
      const events = bodies.flatMap((body) =>
        decodeBody(JSON.parse(body)).resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) =>
            scope.logRecords.map((record) => decodeFields(JSON.parse(record.body.stringValue))),
          ),
        ),
      );
      expect(events).toHaveLength(5);
      expect(events.filter((event) => event["job.detail"] === "****")).toHaveLength(2);
      expect(events.find((event) => event["case.id"] === "defect")).toMatchObject({
        "event.outcome": "failure",
        "error.type": "JOB_FAILED",
        "error.retryable": true,
      });
      expect(events.find((event) => event["case.id"] === "request")).toMatchObject({
        "event.outcome": "failure",
        "http.response.status_code": 503,
        "http.route": "/jobs",
        "request.id": "native-request",
      });
      expect(fallback).toHaveLength(status === 200 ? 0 : 5);
      expect(adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });
      expect(adapter.drops().reasons.transport).toBe(status === 200 ? 0 : 5);
    } finally {
      await handle.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
