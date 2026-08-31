import {
  AuditPublisher,
  BrowserEvents,
  Contract,
  CorrelationContext,
  commitAuditRecord,
  defineTelemetryContract,
  makeEventProducer,
  parseAuditRecord,
  parseRequestId,
  parseRunId,
  parseSpanId,
  parseTraceId,
  TelemetryEventSink,
  type AuditRecordInput,
  type TelemetryContract,
  type TelemetryContractInput,
} from "@equipe-tech/observability";
import {
  createNodeObservabilityFromConfig,
  ingestBrowserEvents,
  layerNodeAuditDigest,
  makeNodeObservability,
} from "@equipe-tech/observability/node";
import { parseNodeObservabilityConfig } from "@equipe-tech/observability";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { audit, initLogger, isEnabled, log, type DrainContext } from "evlog";
import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import { makeEvlogAdapter } from "../src/EvlogAdapter.ts";
import { evlogAdapter } from "../src/index.ts";

const contractDefinition = Contract.telemetryContractDefinition({
  version: 1,
  events: {
    AuditRecorded: Contract.organizationEvents.AuditRecorded,
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
    audited: {
      name: "access.reviewed",
      kind: "audit",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
  },
  metrics: {},
  auditActions: {
    AccessReviewed: {
      action: "access.reviewed",
      resourceType: "account",
      allowedOutcomes: ["denied", "cancelled"],
      reasonCodes: ["approval.missing"],
    },
  },
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

type ReceiverRequest = {
  readonly path: string;
  readonly body: string;
  readonly receivedAt: number;
};

const startReceiver = async (
  responseDelayMillis = 0,
  statusForRequest: (requestNumber: number) => number = () => 200,
) => {
  const bodies: Array<string> = [];
  const requests: Array<ReceiverRequest> = [];
  const server = createServer((request, response) => {
    const receivedAt = Date.now();
    const chunks: Array<Uint8Array> = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      requests.push({ path: request.url ?? "", body, receivedAt });
      const requestNumber = requests.length;
      setTimeout(() => {
        response.writeHead(statusForRequest(requestNumber), {
          "content-type": "application/json",
        });
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("evlogAdapter", () => {
  it("publishes sanitized native audit copies with canonical correlation and dedupe", async () => {
    const receiver = await startReceiver(100);
    const contract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          InvoiceRefunded: {
            action: "invoice.refunded",
            resourceType: "invoice",
            allowedOutcomes: ["success", "failure", "cancelled", "denied"],
            reasonCodes: ["approval.missing"],
          },
        },
      }),
    );
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "audit-test", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: receiver.endpoint },
        evlog: {
          contract,
          policy: {
            attributes: {
              "audit.actor.id": {
                classification: "sensitive",
                required: false,
                metricLabel: false,
              },
              "audit.tenant.id": {
                classification: "sensitive",
                required: false,
                metricLabel: false,
              },
              "request.id": {
                classification: "forbidden",
                required: false,
                metricLabel: false,
              },
              "trace.id": {
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
      maximumBufferedEvents: 1,
      transportRetries: 0,
      auditIntegrity: { strategy: "hash-chain" },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const traceId = await Effect.runPromise(parseTraceId("1".repeat(32)));
    const spanId = await Effect.runPromise(parseSpanId("2".repeat(16)));
    const requestId = await Effect.runPromise(parseRequestId("request-audit"));
    const runId = await Effect.runPromise(parseRunId("run-audit"));
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-record-1",
        action: "invoice.refunded",
        actor: { kind: "service", id: "service@example.com" },
        resource: { id: "invoice-1" },
        outcome: "denied",
        reasonCode: "approval.missing",
        tenantId: "tenant-1",
        occurredAt: "2026-01-02T03:04:05.000Z",
        correlation: new CorrelationContext({
          trace: { _tag: "Traced", traceId, spanId },
          requestId: Option.some(requestId),
          runId: Option.some(runId),
        }),
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.succeed("ledger-row")).pipe(
        Effect.provide(layerNodeAuditDigest),
      ),
    );
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    expect((await Effect.runPromise(publisher.publish(committed.record))).kind).toBe("published");
    expect((await Effect.runPromise(publisher.publish(committed.record))).kind).toBe(
      "deduplicated",
    );
    const overflowRecord = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-record-overflow",
        action: "invoice.refunded",
        actor: { kind: "system" },
        resource: { id: "invoice-overflow" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const overflowCommitted = await Effect.runPromise(
      commitAuditRecord(overflowRecord, () => Effect.void).pipe(
        Effect.provide(layerNodeAuditDigest),
      ),
    );
    expect(await Effect.runPromise(publisher.publish(overflowCommitted.record))).toEqual({
      kind: "published",
    });
    const queueDropRecord = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-record-queue-drop",
        action: "invoice.refunded",
        actor: { kind: "system" },
        resource: { id: "invoice-queue-drop" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const queueDropCommitted = await Effect.runPromise(
      commitAuditRecord(queueDropRecord, () => Effect.void).pipe(
        Effect.provide(layerNodeAuditDigest),
      ),
    );
    expect(await Effect.runPromise(publisher.publish(queueDropCommitted.record))).toEqual({
      kind: "published",
    });
    const terminalQueueDropRecord = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-record-terminal-queue-drop",
        action: "invoice.refunded",
        actor: { kind: "system" },
        resource: { id: "invoice-terminal-queue-drop" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const terminalQueueDropCommitted = await Effect.runPromise(
      commitAuditRecord(terminalQueueDropRecord, () => Effect.void).pipe(
        Effect.provide(layerNodeAuditDigest),
      ),
    );
    expect(await Effect.runPromise(publisher.publish(terminalQueueDropCommitted.record))).toEqual({
      kind: "dropped",
      reason: "queue-overflow",
    });
    expect(publisher.report().reasons.queueOverflow).toBe(1);
    expect(Option.isSome(publisher.report().firstDroppedAt)).toBe(true);
    expect(Option.isSome(publisher.report().lastDroppedAt)).toBe(true);
    await observability.close();
    const closedReceipt = await Effect.runPromise(publisher.publish(committed.record));
    await receiver.close();
    expect(closedReceipt).toEqual({ kind: "dropped", reason: "closed" });
    const logBody = receiver.bodies.find((body) => body.includes("audit-record-1")) ?? "";
    expect(logBody).not.toContain("service@example.com");
    const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(logBody));
    const body = JSON.parse(
      request.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body.stringValue ?? "",
    );
    expect(body["audit.actor.kind"]).toBe("service");
    expect(body["audit.outcome"]).toBe("denied");
    expect(body["event.outcome"]).toBe("failure");
    expect(body["request.id"]).toBeUndefined();
    expect(body["audit.tenant.id"]).toBe("****");
    expect(body["trace.id"]).toBeUndefined();
    expect(body["run.id"]).toBe("run-audit");
    expect(body["event.timestamp"]).toBe(committed.record.committedAt);
    expect(body["event.policy_dropped_attributes"]).toBe(2);
    expect(body.audit.actor.type).toBe("api");
    expect(body.audit.outcome).toBe("denied");
    expect(body.audit.idempotencyKey).toBe("audit-record-1");
    expect(body.audit.context.requestId).toBeUndefined();
    expect(body.audit.context.traceId).toBeUndefined();
    expect(body.audit.context.tenantId).toBe("****");
    expect(body.audit.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(logBody).not.toContain("request-audit");
    expect(logBody).not.toContain("tenant-1");
    expect(logBody).not.toContain(traceId);
    expect(publisher.report().deduplicated).toBe(1);
    expect(publisher.report().reasons.closed).toBe(1);
  });

  it("binds audit publication to the adapter contract before policy and queue admission", async () => {
    const receiver = await startReceiver();
    const boundContract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          AccessReviewed: {
            action: "access.reviewed",
            resourceType: "account",
            allowedOutcomes: ["success"],
            reasonCodes: ["approval.missing"],
          },
        },
      }),
    );
    const unknownActionContract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          InvoiceRefunded: {
            action: "invoice.refunded",
            resourceType: "invoice",
            allowedOutcomes: ["success"],
          },
        },
      }),
    );
    const resourceDriftContract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          AccessReviewed: {
            action: "access.reviewed",
            resourceType: "invoice",
            allowedOutcomes: ["success"],
          },
        },
      }),
    );
    const outcomeDriftContract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          AccessReviewed: {
            action: "access.reviewed",
            resourceType: "account",
            allowedOutcomes: ["denied"],
          },
        },
      }),
    );
    const reasonDriftContract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          AccessReviewed: {
            action: "access.reviewed",
            resourceType: "account",
            allowedOutcomes: ["success"],
            reasonCodes: ["policy.changed"],
          },
        },
      }),
    );
    const commitFor = async <Definition extends TelemetryContractInput>(
      contract: TelemetryContract<Definition>,
      input: AuditRecordInput,
    ) => {
      const record = await Effect.runPromise(parseAuditRecord(contract, input));
      return Effect.runPromise(
        commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
      );
    };
    const foreignRecords = [
      await commitFor(unknownActionContract, {
        recordId: "audit-foreign-action",
        action: "invoice.refunded",
        actor: { kind: "system" },
        resource: { id: "invoice-1" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
      await commitFor(resourceDriftContract, {
        recordId: "audit-foreign-resource",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "invoice-2" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
      await commitFor(outcomeDriftContract, {
        recordId: "audit-foreign-outcome",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-3" },
        outcome: "denied",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
      await commitFor(reasonDriftContract, {
        recordId: "audit-foreign-reason",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-4" },
        outcome: "success",
        reasonCode: "policy.changed",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    ];
    const sameContract = await commitFor(boundContract, {
      recordId: "audit-same-contract",
      action: "access.reviewed",
      actor: { kind: "system" },
      resource: { id: "account-5" },
      outcome: "success",
      reasonCode: "approval.missing",
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "audit-contract-binding", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: receiver.endpoint },
        evlog: {
          contract: boundContract,
          policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
        },
        sentry: { enabled: false },
      }),
    );
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 5,
      maximumBufferedEvents: 5,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    for (const committed of foreignRecords) {
      expect(await Effect.runPromise(publisher.publish(committed.record))).toEqual({
        kind: "dropped",
        reason: "contract-rejected",
      });
    }
    expect(await Effect.runPromise(publisher.publish(sameContract.record))).toEqual({
      kind: "published",
    });
    await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    expect(wire).toContain("audit-same-contract");
    for (const recordId of [
      "audit-foreign-action",
      "audit-foreign-resource",
      "audit-foreign-outcome",
      "audit-foreign-reason",
    ]) {
      expect(wire).not.toContain(recordId);
    }
    expect(publisher.report().published).toBe(1);
    expect(publisher.report().dropped).toBe(4);
    expect(publisher.report().reasons.contractRejected).toBe(4);
  });

  it("rejects foreign audit records when the adapter contract has no audit capability", async () => {
    const receiver = await startReceiver();
    const boundContract = await Effect.runPromise(
      defineTelemetryContract({ version: 1, events: {}, metrics: {}, auditActions: {} }),
    );
    const foreignContract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
        metrics: {},
        auditActions: {
          AccessReviewed: {
            action: "access.reviewed",
            resourceType: "account",
            allowedOutcomes: ["success"],
          },
        },
      }),
    );
    const record = await Effect.runPromise(
      parseAuditRecord(foreignContract, {
        recordId: "audit-no-capability",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-1" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "empty-contract-adapter", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: receiver.endpoint },
        evlog: {
          contract: boundContract,
          policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
        },
        sentry: { enabled: false },
      }),
    );
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    expect(await Effect.runPromise(publisher.publish(committed.record))).toEqual({
      kind: "dropped",
      reason: "contract-rejected",
    });
    await observability.close();
    await receiver.close();
    expect(receiver.bodies.join("\n")).not.toContain("audit-no-capability");
    expect(publisher.report().published).toBe(0);
    expect(publisher.report().dropped).toBe(1);
    expect(publisher.report().reasons.contractRejected).toBe(1);
  });

  it("returns policy-rejected when policy changes an immutable audit anchor", async () => {
    const receiver = await startReceiver();
    const contract = await Effect.runPromise(defineTelemetryContract(contractDefinition));
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "audit-policy-test", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: receiver.endpoint },
        evlog: {
          contract,
          policy: {
            attributes: {
              "audit.record.id": {
                classification: "sensitive",
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
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-policy-rejected",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-1" },
        outcome: "denied",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    expect(await Effect.runPromise(publisher.publish(committed.record))).toEqual({
      kind: "dropped",
      reason: "policy-rejected",
    });
    expect(publisher.report().reasons.policyRejected).toBe(1);
    expect(Option.isSome(publisher.report().firstDroppedAt)).toBe(true);
    expect(Option.isSome(publisher.report().lastDroppedAt)).toBe(true);
    await observability.close();
    await receiver.close();
    expect(receiver.bodies.join("\n")).not.toContain("audit-policy-rejected");
  });

  it("rejects every timestamp policy mutation before queueing and preserves sibling batches", async () => {
    const cases = [
      {
        name: "forbidden",
        attributes: {
          "event.timestamp": {
            classification: "forbidden",
            required: false,
            metricLabel: false,
          },
        },
        blockedKeys: [],
      },
      {
        name: "sensitive",
        attributes: {
          "event.timestamp": {
            classification: "sensitive",
            required: false,
            metricLabel: false,
          },
        },
        blockedKeys: [],
      },
      { name: "blocked", attributes: {}, blockedKeys: ["timestamp"] },
    ] satisfies ReadonlyArray<{
      readonly name: string;
      readonly attributes: Contract.AttributeDefinitionsInput;
      readonly blockedKeys: ReadonlyArray<string>;
    }>;
    for (const testCase of cases) {
      const receiver = await startReceiver();
      const contract = await Effect.runPromise(defineTelemetryContract(contractDefinition));
      const config = await Effect.runPromise(
        parseNodeObservabilityConfig({
          enabled: true,
          profile: "worker",
          service: { name: "audit-policy-test", version: "1.2.3", environment: "test" },
          telemetry: { endpoint: receiver.endpoint },
          evlog: {
            contract,
            policy: {
              attributes: testCase.attributes,
              blockedKeys: testCase.blockedKeys,
              blockedValuePatterns: [],
            },
          },
          sentry: { enabled: false },
        }),
      );
      const adapter = evlogAdapter({
        installGlobalLogger: false,
        batchSize: 4,
        maximumBufferedEvents: 4,
        transportRetries: 0,
      });
      const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
      if (!observability.enabled) throw new Error("Expected enabled observability.");
      const record = await Effect.runPromise(
        parseAuditRecord(contract, {
          recordId: `audit-timestamp-${testCase.name}`,
          action: "access.reviewed",
          actor: { kind: "system" },
          resource: { id: "account-1" },
          outcome: "denied",
          occurredAt: "2026-01-02T03:04:05.000Z",
        }),
      );
      const committed = await Effect.runPromise(
        commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
      );
      const publisher = await Effect.runPromise(
        AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
      );
      expect(await Effect.runPromise(publisher.publish(committed.record))).toEqual({
        kind: "dropped",
        reason: "policy-rejected",
      });
      const producer = makeEventProducer(contract);
      for (const sibling of ["sibling-a", "sibling-b", "sibling-c"]) {
        await observability.runtime.runPromise(
          producer
            .emit("completed", {
              outcome: "success",
              durationMs: 1,
              attributes: { "job.name": `${testCase.name}-${sibling}` },
            })
            .pipe(Effect.provide(observability.eventLayer)),
        );
      }
      expect(adapter.pending()).toEqual({
        count: 3,
        serializedBytes: expect.any(Number),
      });
      await observability.close();
      await receiver.close();
      const wire = receiver.bodies.join("\n");
      expect(wire).not.toContain(`audit-timestamp-${testCase.name}`);
      expect(wire).not.toContain('"timestamp":"undefined"');
      expect(wire).not.toContain('"timeUnixNano":"NaN"');
      for (const sibling of ["sibling-a", "sibling-b", "sibling-c"]) {
        expect(wire).toContain(`${testCase.name}-${sibling}`);
      }
      expect(publisher.report().reasons.policyRejected).toBe(1);
      expect(adapter.drops().reasons.transport).toBe(0);
    }
  });

  it("expires delivered audit dedupe entries with TestClock", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      auditDedupeWindowMillis: 1_000,
      transportRetries: 0,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const observability = yield* makeNodeObservability(config, [adapter.registration]);
        if (!observability.enabled) return yield* Effect.die("Expected enabled observability.");
        const record = yield* parseAuditRecord(contract, {
          recordId: "audit-test-clock",
          action: "access.reviewed",
          actor: { kind: "system" },
          resource: { id: "account-clock" },
          outcome: "denied",
          occurredAt: "2026-01-02T03:04:05.000Z",
        });
        const committed = yield* commitAuditRecord(record, () => Effect.void).pipe(
          Effect.provide(layerNodeAuditDigest),
        );
        const publisher = yield* AuditPublisher.pipe(Effect.provide(observability.auditLayer));
        expect(yield* publisher.publish(committed.record)).toEqual({ kind: "published" });
        yield* Effect.promise(() => observability.flush());
        expect(yield* publisher.publish(committed.record)).toEqual({ kind: "deduplicated" });
        yield* TestClock.adjust("1001 millis");
        expect(yield* publisher.publish(committed.record)).toEqual({ kind: "published" });
        yield* Effect.promise(() => observability.close());
      }).pipe(Effect.provide(TestClock.layer())),
    );
    await receiver.close();
    expect(receiver.bodies.filter((body) => body.includes("audit-test-clock"))).toHaveLength(2);
    expect(receiver.bodies.join("\n")).toContain('\\"audit.actor.id\\":\\"system\\"');
  });

  it("keeps audit drop timestamps monotonic across pipeline and publish callbacks", async () => {
    const receiver = await startReceiver(0, () => 503);
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      maximumAttempts: 1,
      transportRetries: 0,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const observability = yield* makeNodeObservability(config, [adapter.registration]);
        if (!observability.enabled) return yield* Effect.die("Expected enabled observability.");
        const record = yield* parseAuditRecord(contract, {
          recordId: "audit-drop-clock",
          action: "access.reviewed",
          actor: { kind: "system" },
          resource: { id: "account-clock" },
          outcome: "denied",
          occurredAt: "2026-01-02T03:04:05.000Z",
        });
        const committed = yield* commitAuditRecord(record, () => Effect.void).pipe(
          Effect.provide(layerNodeAuditDigest),
        );
        const publisher = yield* AuditPublisher.pipe(Effect.provide(observability.auditLayer));
        expect(yield* publisher.publish(committed.record)).toEqual({ kind: "published" });
        yield* Effect.promise(() => observability.flush());
        expect(publisher.report().reasons.transport).toBe(1);
        expect(Option.getOrThrow(adapter.drops().firstDroppedAt)).toBe(
          Option.getOrThrow(publisher.report().firstDroppedAt),
        );
        expect(Option.getOrThrow(adapter.drops().lastDroppedAt)).toBe(
          Option.getOrThrow(publisher.report().lastDroppedAt),
        );
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(() => observability.close());
        expect(yield* publisher.publish(committed.record)).toEqual({
          kind: "dropped",
          reason: "closed",
        });
        const report = publisher.report();
        expect(Option.getOrThrow(report.firstDroppedAt)).toBe("1970-01-01T00:00:00.000Z");
        expect(Option.getOrThrow(report.lastDroppedAt)).toBe("1970-01-01T00:00:01.000Z");
      }).pipe(Effect.provide(TestClock.layer())),
    );
    await receiver.close();
  });

  it("retries a concurrent duplicate after integrity rejection", async () => {
    const receiver = await startReceiver();
    const { contract, config } = await makeConfig(receiver.endpoint);
    const firstIntegrityStarted = Promise.withResolvers<void>();
    const releaseFirstIntegrity = Promise.withResolvers<void>();
    let integrityAttempts = 0;
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      maximumAttempts: 1,
      transportRetries: 0,
      auditIntegrity: {
        strategy: "hash-chain",
        state: {
          load: () => null,
          save: async () => {
            integrityAttempts += 1;
            if (integrityAttempts === 1) {
              firstIntegrityStarted.resolve();
              await releaseFirstIntegrity.promise;
              throw new Error("integrity rejected");
            }
          },
        },
      },
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-concurrent-integrity",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-integrity" },
        outcome: "denied",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    const first = Effect.runPromise(publisher.publish(committed.record));
    await firstIntegrityStarted.promise;
    let secondSettled = false;
    const second = Effect.runPromise(publisher.publish(committed.record)).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondSettled).toBe(false);
    releaseFirstIntegrity.resolve();
    expect(await first).toEqual({ kind: "dropped", reason: "transport" });
    expect(await second).toEqual({ kind: "published" });
    await observability.close();
    await receiver.close();
    expect(integrityAttempts).toBe(2);
    expect(publisher.report().deduplicated).toBe(0);
    expect(publisher.report().reasons.transport).toBe(1);
  });

  it("retries a concurrent duplicate after terminal transport rejection", async () => {
    const receiver = await startReceiver(100, (requestNumber) => (requestNumber === 1 ? 503 : 200));
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      maximumAttempts: 1,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-concurrent-transport",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-transport" },
        outcome: "denied",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    expect(await Effect.runPromise(publisher.publish(committed.record))).toEqual({
      kind: "published",
    });
    let duplicateSettled = false;
    const duplicate = Effect.runPromise(publisher.publish(committed.record)).finally(() => {
      duplicateSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(duplicateSettled).toBe(false);
    expect(await duplicate).toEqual({ kind: "published" });
    await observability.close();
    await receiver.close();
    expect(
      receiver.requests.filter((request) => request.body.includes("audit-concurrent-transport")),
    ).toHaveLength(2);
    expect(publisher.report().deduplicated).toBe(0);
    expect(publisher.report().reasons.transport).toBe(1);
  });

  it("reports audit transport drops after blackhole exhaustion", async () => {
    const receiver = await startReceiver(0, () => 503);
    const { contract, config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      maximumAttempts: 1,
      transportRetries: 0,
    });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-transport-drop",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-transport" },
        outcome: "denied",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    expect(await Effect.runPromise(publisher.publish(committed.record))).toEqual({
      kind: "published",
    });
    await observability.close();
    await receiver.close();
    expect(publisher.report().reasons.transport).toBe(1);
    expect(publisher.report().dropped).toBe(1);
    expect(Option.isSome(publisher.report().firstDroppedAt)).toBe(true);
    expect(Option.isSome(publisher.report().lastDroppedAt)).toBe(true);
  });

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
    await observability.runtime.runPromise(
      producer
        .emit("audited", {
          outcome: "denied",
          audit: {
            action: "access.reviewed",
            actor: { kind: "system" },
            resourceType: "account",
            resourceId: "account-1",
            reasonCode: "approval.missing",
          },
          attributes: {},
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.runtime.runPromise(
      producer
        .emit("audited", {
          outcome: "cancelled",
          audit: {
            action: "access.reviewed",
            actor: { kind: "system" },
            resourceType: "account",
            resourceId: "account-cancelled",
          },
          attributes: {},
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await receiver.close();
    const auditWire = receiver.bodies.find((body) => body.includes("approval.missing")) ?? "";
    const auditRequest = Schema.decodeUnknownSync(RequestBody)(JSON.parse(auditWire));
    const auditBody = JSON.parse(
      auditRequest.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body.stringValue ?? "",
    );
    expect(auditBody["audit.reason_code"]).toBe("approval.missing");
    expect(auditBody["audit.outcome"]).toBe("denied");
    expect(auditBody["audit.actor.id"]).toBe("system");
    expect(auditBody["event.outcome"]).toBe("failure");
    const cancelledWire = receiver.bodies.find((body) => body.includes("account-cancelled")) ?? "";
    const cancelledRequest = Schema.decodeUnknownSync(RequestBody)(JSON.parse(cancelledWire));
    const cancelledBody = JSON.parse(
      cancelledRequest.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body.stringValue ?? "",
    );
    expect(cancelledBody["audit.outcome"]).toBe("cancelled");
    expect(cancelledBody["event.outcome"]).toBe("failure");
    const logBody = receiver.bodies.find((body) => body.includes("job.completed")) ?? "";
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

  it("projects browser defects with typed error context and failure outcome", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    await observability.runtime.runPromise(
      TelemetryEventSink.pipe(
        Effect.flatMap((sink) =>
          sink.recordBrowserBatch([
            {
              id: "browser-defect",
              name: "job.processing",
              occurredAt: 1,
              attributes: { "job.name": "billing" },
              error: { type: "TypeError", message: "render failed", retryable: false },
              admission: { policyDroppedAttributes: 0 },
            },
          ]),
        ),
        Effect.provide(observability.eventLayer),
      ),
    );
    await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    expect(wire).toContain("browser-defect");
    expect(wire).toContain("TypeError");
    expect(wire).toContain("render failed");
    expect(wire).toContain("failure");
  });

  it("rejects every illegal browser error membership branch", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ installGlobalLogger: false, batchSize: 1 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const defectWithoutError = {
      id: "defect-without-error",
      name: "job.processing",
      occurredAt: 1,
      attributes: { "job.name": "billing" },
      admission: { policyDroppedAttributes: 0 },
    };
    const nonDefectWithError = {
      id: "event-with-error",
      name: "job.completed",
      occurredAt: 1,
      attributes: { "job.name": "billing" },
      error: { type: "TypeError", message: "invalid", retryable: false },
      admission: { policyDroppedAttributes: 0 },
    };
    for (const event of [defectWithoutError, nonDefectWithError]) {
      const failure = await observability.runtime.runPromise(
        Effect.flip(
          TelemetryEventSink.pipe(
            Effect.flatMap((sink) => sink.recordBrowserBatch([event])),
            Effect.provide(observability.eventLayer),
          ),
        ),
      );
      expect(failure.code).toBe("OBS_EVENT_INVALID_FIELD");
      expect(failure.attributeName).toBe("error");
    }
    await observability.close();
    await receiver.close();
    expect(receiver.bodies.join("\n")).not.toContain("defect-without-error");
    expect(receiver.bodies.join("\n")).not.toContain("event-with-error");
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

  it("normalizes safe native timestamps and rejects batch-poison values before insertion", async () => {
    const receiver = await startReceiver();
    const { config } = await makeConfig(receiver.endpoint);
    const adapter = evlogAdapter({ batchSize: 50, transportRetries: 0 });
    const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
    const boundary = BrowserEvents.maxBrowserEventOccurredAt;
    const safeTimestamps = [
      "2026-08-30T16:41:55.558Z",
      new Date("2025-01-02T03:04:05.006Z"),
      1_700_000_000_123,
      boundary,
    ];
    for (const [index, timestamp] of safeTimestamps.entries()) {
      log.info({ "event.name": "job.completed", "job.name": `safe-${index}`, timestamp });
    }
    log.info({ "event.name": "job.completed", "job.name": "generated" });
    for (const timestamp of [
      "not-a-date",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      "3000-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.000Z",
      boundary + 1,
    ]) {
      log.info({ "event.name": "job.completed", "job.name": "poison", timestamp });
    }
    await observability.close();
    await receiver.close();
    const wire = receiver.bodies.join("\n");
    for (let index = 0; index < safeTimestamps.length; index += 1) {
      expect(wire).toContain(`safe-${index}`);
    }
    expect(wire).toContain("generated");
    expect(wire).toContain(new Date(boundary).toISOString());
    expect(wire).not.toContain("poison");
    expect(adapter.drops().reasons.contractRejected).toBe(7);
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

  it("sanitizes every canonical string field on contract, browser, and global paths", async () => {
    const adversarial = [
      "Bearer AAAABBBBCCCCDDDDEEEEFFFF",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
      "sk_live_providerSecret123",
      "person@example.com",
      "-----BEGIN PRIVATE KEY-----private-material-----END PRIVATE KEY-----",
      "cookie=session-secret",
      "password=hunter2",
      "canonicalsecret",
    ];
    const secretText = adversarial.join(" ");
    const definition = Contract.telemetryContractDefinition({
      version: 1,
      events: {
        AuditRecorded: Contract.organizationEvents.AuditRecorded,
        operation: {
          name: "canonicalsecret.operation",
          kind: "operation",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "case.name": { classification: "public", required: true, metricLabel: false },
          },
        },
        request: {
          name: "canonicalsecret.request",
          kind: "request",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "case.name": { classification: "public", required: true, metricLabel: false },
          },
        },
        defect: {
          name: "canonicalsecret.defect",
          kind: "defect",
          defaultSeverity: "error",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "case.name": { classification: "public", required: true, metricLabel: false },
          },
        },
        audit: {
          name: "canonicalsecret.audit",
          kind: "audit",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes: {
            "case.name": { classification: "public", required: true, metricLabel: false },
          },
        },
      },
      metrics: {},
      auditActions: {
        CanonicalAction: {
          action: "canonicalsecret.action",
          resourceType: "canonicalsecret_resource",
          allowedOutcomes: ["success", "failure"],
        },
      },
    });
    const run = async (endpoint: URL, stdout: Array<string>) => {
      const contract = await Effect.runPromise(defineTelemetryContract(definition));
      const config = await Effect.runPromise(
        parseNodeObservabilityConfig({
          enabled: true,
          profile: "worker",
          service: { name: "evlog-test", version: "1.2.3", environment: "test" },
          telemetry: { endpoint },
          evlog: {
            contract,
            policy: {
              attributes: {},
              blockedKeys: [],
              blockedValuePatterns: [
                "canonicalsecret",
                "operation",
                "request",
                "defect",
                "audit",
                "success",
                "failure",
                "info",
                "error",
                "wide",
                "browser",
                "EvlogError",
              ],
            },
          },
          sentry: { enabled: false },
        }),
      );
      let drain: ((context: DrainContext) => void | Promise<void>) | undefined;
      const adapter = makeEvlogAdapter(
        {
          batchSize: 20,
          maximumAttempts: 1,
          transportRetries: 0,
          stdout: { write: (line) => stdout.push(line) > 0 },
        },
        (options) => {
          if (options === undefined) throw new Error("Expected logger options.");
          drain = options.drain;
          initLogger(options);
        },
      );
      const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
      if (!observability.enabled) throw new Error("Expected enabled observability.");
      const producer = makeEventProducer(contract);
      const requestId = await Effect.runPromise(parseRequestId("canonicalsecret-request"));
      const runId = await Effect.runPromise(parseRunId("canonicalsecret-run"));
      const traceId = await Effect.runPromise(parseTraceId("1".repeat(32)));
      const spanId = await Effect.runPromise(parseSpanId("2".repeat(16)));
      await observability.runtime.runPromise(
        producer
          .emit("request", {
            outcome: "success",
            durationMs: 1,
            http: {
              method: secretText,
              route: `/checkout?token=${secretText}`,
              statusCode: 200,
            },
            correlation: new CorrelationContext({
              trace: { _tag: "Traced", traceId, spanId },
              requestId: Option.some(requestId),
              runId: Option.some(runId),
            }),
            attributes: { "case.name": "contract-request" },
          })
          .pipe(Effect.provide(observability.eventLayer)),
      );
      await observability.runtime.runPromise(
        producer
          .emit("defect", {
            error: {
              type: secretText,
              message: secretText,
              retryable: true,
            },
            attributes: { "case.name": "contract-defect" },
          })
          .pipe(Effect.provide(observability.eventLayer)),
      );
      await observability.runtime.runPromise(
        producer
          .emit("audit", {
            outcome: "failure",
            audit: {
              action: "canonicalsecret.action",
              actor: { kind: "user", id: "person@example.com" },
              resourceType: "canonicalsecret_resource",
              resourceId: "cookie=session-secret",
            },
            attributes: { "case.name": "contract-audit" },
          })
          .pipe(Effect.provide(observability.eventLayer)),
      );
      const sink = await observability.runtime.runPromise(
        TelemetryEventSink.pipe(Effect.provide(observability.eventLayer)),
      );
      await Effect.runPromise(
        sink.recordBrowserBatch([
          {
            id: secretText,
            name: "canonicalsecret.operation",
            occurredAt: 0,
            attributes: { "case.name": "browser-event" },
            admission: { policyDroppedAttributes: 0 },
          },
        ]),
      );
      if (drain === undefined) throw new Error("Expected an installed global drain.");
      await drain({
        event: {
          timestamp: "1970-01-01T00:00:00.000Z",
          level: "info",
          service: "evlog-test",
          environment: "test",
          "event.name": "canonicalsecret.request",
          "case.name": "global-request",
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
        },
        request: {
          method: secretText,
          path: `/global?token=${secretText}`,
          requestId: secretText,
        },
      });
      await observability.close();
      return adapter.drops();
    };
    const receiver = await startReceiver();
    const wireStdout: Array<string> = [];
    const wireDrops = await run(receiver.endpoint, wireStdout);
    await receiver.close();
    const fallback: Array<string> = [];
    await run(new URL("http://127.0.0.1:1"), fallback);
    const outputs = [receiver.bodies.join("\n"), fallback.join("\n")];
    const fields = [
      "request.id",
      "run.id",
      "http.request.method",
      "http.route",
      "error.type",
      "error.name",
      "error.message",
      "audit.actor.id",
      "audit.action",
      "audit.resource.type",
      "audit.resource.id",
      "event.name",
      "event.kind",
      "event.type",
      "event.severity",
      "event.outcome",
      "event.source",
      "browser.event.id",
    ];
    for (const output of outputs) {
      for (const secret of adversarial) expect(output).not.toContain(secret);
      expect(output).not.toMatch(/canonicalsecret/i);
      for (const field of fields) expect(output).toContain(field);
      expect(output).toContain("1".repeat(32));
      expect(output).toContain("2".repeat(16));
      expect(output).toContain("browser.event.occurred_at");
    }
    expect(wireStdout).toHaveLength(0);
    expect(wireDrops.reasons.transport).toBe(0);
  });

  it("sanitizes canonical defect text while preserving structured error semantics", async () => {
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
    const secrets = [
      "Bearer AAAABBBBCCCCDDDDEEEEFFFF",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
      "sk_live_providerSecret123",
      "person@example.com",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      "password=hunter2",
    ];
    await observability.runtime.runPromise(
      makeEventProducer(contract)
        .emit("failed", {
          error: {
            type: "PAYMENT_DECLINED",
            message: secrets.join(" "),
            retryable: true,
          },
          attributes: { "job.name": "structured-error" },
        })
        .pipe(Effect.provide(observability.eventLayer)),
    );
    await observability.close();
    await receiver.close();
    const fallback = await makeConfig(new URL("http://127.0.0.1:1"));
    const fallbackAdapter = evlogAdapter({
      installGlobalLogger: false,
      batchSize: 1,
      maximumAttempts: 1,
      transportRetries: 0,
      stdout: { write: (line) => lines.push(line) > 0 },
    });
    const fallbackObservability = await createNodeObservabilityFromConfig(fallback.config, [
      fallbackAdapter.registration,
    ]);
    if (!fallbackObservability.enabled) throw new Error("Expected enabled observability.");
    await fallbackObservability.runtime.runPromise(
      makeEventProducer(fallback.contract)
        .emit("failed", {
          error: {
            type: "PAYMENT_DECLINED",
            message: secrets.join(" "),
            retryable: true,
          },
          attributes: { "job.name": "structured-error" },
        })
        .pipe(Effect.provide(fallbackObservability.eventLayer)),
    );
    await fallbackObservability.close();
    const wire = receiver.bodies.join("\n");
    expect(lines).toHaveLength(1);
    for (const secret of secrets) {
      expect(wire).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    }
    expect(wire).toContain('\\"error.type\\":\\"PAYMENT_DECLINED\\"');
    expect(wire).toContain('\\"error.name\\":\\"EvlogError\\"');
    expect(wire).toContain('\\"error.status\\":503');
    expect(wire).toContain('\\"error.retryable\\":true');
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
    const runRetryScenario = async (maximumAttempts: number) => {
      const receiver = await startReceiver(50, () => 503);
      const { contract, config } = await makeConfig(receiver.endpoint);
      const lines: Array<string> = [];
      const adapter = evlogAdapter({
        installGlobalLogger: false,
        batchSize: 1,
        maximumAttempts,
        initialRetryDelayMillis: 10,
        maximumRetryDelayMillis: 15,
        transportTimeoutMillis: 5,
        transportRetries: 0,
        stdout: { write: (line) => lines.push(line) > 0 },
      });
      const observability = await createNodeObservabilityFromConfig(config, [adapter.registration]);
      if (!observability.enabled) throw new Error("Expected enabled observability.");
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
      await receiver.close();
      const markedLogRequests = receiver.requests.filter(
        (request) => request.path === "/v1/logs" && request.body.includes("retry-exhausted"),
      );
      return { adapter, lines, markedLogRequests };
    };

    const threeAttempts = await runRetryScenario(3);
    expect(threeAttempts.markedLogRequests).toHaveLength(3);
    const firstAttempt = threeAttempts.markedLogRequests[0];
    const secondAttempt = threeAttempts.markedLogRequests[1];
    const thirdAttempt = threeAttempts.markedLogRequests[2];
    if (firstAttempt === undefined || secondAttempt === undefined || thirdAttempt === undefined) {
      throw new Error("Expected three marked log attempts.");
    }
    expect(secondAttempt.receivedAt - firstAttempt.receivedAt).toBeGreaterThanOrEqual(10);
    expect(thirdAttempt.receivedAt - secondAttempt.receivedAt).toBeGreaterThanOrEqual(15);
    expect(threeAttempts.adapter.drops().reasons.transport).toBe(1);
    expect(threeAttempts.lines).toHaveLength(1);
    expect(threeAttempts.adapter.pending()).toEqual({ count: 0, serializedBytes: 0 });

    const twoAttempts = await runRetryScenario(2);
    expect(twoAttempts.markedLogRequests).toHaveLength(2);
  }, 10_000);

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

  it("requires the audit.recorded organization event for active audit publication", async () => {
    const contract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: {},
        metrics: {},
        auditActions: {
          AccessReviewed: {
            action: "access.reviewed",
            resourceType: "account",
            allowedOutcomes: ["success"],
          },
        },
      }),
    );
    const config = await Effect.runPromise(
      parseNodeObservabilityConfig({
        enabled: true,
        profile: "worker",
        service: { name: "audit-contract-test", version: "1.2.3", environment: "test" },
        telemetry: { endpoint: new URL("http://127.0.0.1:1") },
        evlog: {
          contract,
          policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
        },
        sentry: { enabled: false },
      }),
    );
    await expect(
      createNodeObservabilityFromConfig(config, [
        evlogAdapter({ installGlobalLogger: false }).registration,
      ]),
    ).rejects.toMatchObject({
      code: "OBS_OBSERVABILITY_STARTUP_FAILED",
      cause: {
        cause: {
          code: "OBS_EVLOG_AUDIT_CONTRACT_INVALID",
          message:
            "Audit publication requires Contract.organizationEvents.AuditRecorded when the contract declares audit actions.",
        },
      },
    });
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
    audit({
      action: "access.reviewed",
      actor: { type: "user", id: "private@example.com" },
      target: { type: "account", id: "private-account" },
    });
    await observability.close();
    expect(adapter.drops().reasons.contractRejected).toBe(6);
    expect(adapter.drops().total).toBe(6);
    expect(Option.isSome(adapter.drops().firstDroppedAt)).toBe(true);
    expect(Option.isSome(adapter.drops().lastDroppedAt)).toBe(true);
    expect(JSON.stringify(adapter.drops())).not.toContain("missing required");
    expect(JSON.stringify(adapter.drops())).not.toContain("private@example.com");
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
