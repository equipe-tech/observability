import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import {
  defineTelemetryContract,
  makeEventProducer,
  telemetryContractDefinition,
  type TelemetryContract,
  type TelemetryContractInput,
} from "../src/contract/index.ts";
import { CorrelationContext, parseRequestId, parseRunId } from "../src/Correlation.ts";
import { layerWideEvent } from "../src/effect/WideEventSink.ts";
import * as Testing from "../src/testing/index.ts";

const contractInput = telemetryContractDefinition({
  version: 1,
  events: {
    Request: {
      name: "request.completed",
      kind: "request",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
    Defect: {
      name: "browser.error",
      kind: "defect",
      defaultSeverity: "error",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
    Audit: {
      name: "access.reviewed",
      kind: "audit",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {},
    },
    Exported: {
      name: "contract.exported",
      kind: "domain",
      defaultSeverity: "info",
      mandatory: true,
      sampling: { kind: "always" },
      attributes: {
        "contract.fixture": {
          classification: "public",
          required: true,
          metricLabel: true,
        },
      },
    },
  },
  metrics: {},
  auditActions: {
    AccessReviewed: {
      action: "access.reviewed",
      resourceType: "account",
      allowedOutcomes: ["success", "failure", "cancelled", "denied"],
      reasonCodes: ["approval.missing"],
    },
  },
});

const attributeValue = (attributes: Testing.CapturedAttributes, name: string) =>
  Option.getOrUndefined(Testing.attribute(attributes, name));

describe("contract OTLP integration", () => {
  it.live("exports a valid contract event through WideEvent and the in-memory OTLP path", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract(contractInput);
      const producer = makeEventProducer(contract);
      const run = yield* Testing.run(
        producer
          .emit("Exported", {
            outcome: "success",
            attributes: { "contract.fixture": "valid" },
          })
          .pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isSuccess(run.exit));
      const log = run.telemetry.logs.find(
        (candidate) => attributeValue(candidate.attributes, "event.name") === "contract.exported",
      );
      assert.isDefined(log);
      assert.strictEqual(attributeValue(log.attributes, "event.kind"), "wide");
      assert.strictEqual(attributeValue(log.attributes, "event.type"), "domain");
      assert.strictEqual(attributeValue(log.attributes, "event.outcome"), "success");
      assert.strictEqual(attributeValue(log.attributes, "contract.fixture"), "valid");
    }),
  );

  it.live("exports request, error, audit and correlation canonical fields", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract(contractInput);
      const producer = makeEventProducer(contract);
      const requestId = yield* parseRequestId("request-1");
      const runId = yield* parseRunId("run-1");
      const run = yield* Testing.run(
        Effect.all([
          producer.emit("Request", {
            outcome: "success",
            durationMs: 12,
            http: { method: "GET", route: "/health", statusCode: 200 },
            correlation: new CorrelationContext({
              requestId: Option.some(requestId),
              runId: Option.some(runId),
            }),
            attributes: {},
          }),
          producer.emit("Defect", {
            error: { type: "TypeError", message: "failed", retryable: false },
            attributes: {},
          }),
          producer.emit("Audit", {
            outcome: "success",
            audit: {
              action: "access.reviewed",
              actor: { kind: "user", id: "user-1" },
              resourceType: "account",
              resourceId: "account-success",
            },
            attributes: {},
          }),
          producer.emit("Audit", {
            outcome: "denied",
            audit: {
              action: "access.reviewed",
              actor: { kind: "system" },
              resourceType: "account",
              resourceId: "account-denied",
              reasonCode: "approval.missing",
            },
            attributes: {},
          }),
          producer.emit("Audit", {
            outcome: "cancelled",
            audit: {
              action: "access.reviewed",
              actor: { kind: "system" },
              resourceType: "account",
              resourceId: "account-cancelled",
            },
            attributes: {},
          }),
        ]).pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isSuccess(run.exit));
      const request = run.telemetry.logs.find(
        (candidate) => attributeValue(candidate.attributes, "event.name") === "request.completed",
      );
      assert.isDefined(request);
      assert.strictEqual(attributeValue(request.attributes, "event.duration_ms"), 12);
      assert.strictEqual(attributeValue(request.attributes, "http.request.method"), "GET");
      assert.strictEqual(attributeValue(request.attributes, "http.route"), "/health");
      assert.strictEqual(attributeValue(request.attributes, "http.response.status_code"), 200);
      assert.strictEqual(attributeValue(request.attributes, "request.id"), "request-1");
      assert.strictEqual(attributeValue(request.attributes, "run.id"), "run-1");
      const defect = run.telemetry.logs.find(
        (candidate) => attributeValue(candidate.attributes, "event.name") === "browser.error",
      );
      assert.isDefined(defect);
      assert.strictEqual(attributeValue(defect.attributes, "error.type"), "TypeError");
      assert.strictEqual(attributeValue(defect.attributes, "error.message"), "failed");
      assert.strictEqual(attributeValue(defect.attributes, "error.retryable"), false);
      const audits = run.telemetry.logs.filter(
        (candidate) => attributeValue(candidate.attributes, "event.name") === "access.reviewed",
      );
      assert.lengthOf(audits, 3);
      const success = audits.find(
        (candidate) =>
          attributeValue(candidate.attributes, "audit.resource.id") === "account-success",
      );
      assert.isDefined(success);
      assert.strictEqual(attributeValue(success.attributes, "event.outcome"), "success");
      assert.strictEqual(attributeValue(success.attributes, "audit.outcome"), "success");
      assert.strictEqual(attributeValue(success.attributes, "audit.actor.kind"), "user");
      assert.strictEqual(attributeValue(success.attributes, "audit.actor.id"), "user-1");
      const denied = audits.find(
        (candidate) =>
          attributeValue(candidate.attributes, "audit.resource.id") === "account-denied",
      );
      assert.isDefined(denied);
      assert.strictEqual(attributeValue(denied.attributes, "event.outcome"), "failure");
      assert.strictEqual(attributeValue(denied.attributes, "audit.outcome"), "denied");
      assert.strictEqual(
        attributeValue(denied.attributes, "audit.reason_code"),
        "approval.missing",
      );
      assert.strictEqual(attributeValue(denied.attributes, "audit.actor.kind"), "system");
      assert.strictEqual(attributeValue(denied.attributes, "audit.actor.id"), "system");
      const cancelled = audits.find(
        (candidate) =>
          attributeValue(candidate.attributes, "audit.resource.id") === "account-cancelled",
      );
      assert.isDefined(cancelled);
      assert.strictEqual(attributeValue(cancelled.attributes, "event.outcome"), "failure");
      assert.strictEqual(attributeValue(cancelled.attributes, "audit.outcome"), "cancelled");
      assert.strictEqual(attributeValue(cancelled.attributes, "audit.actor.id"), "system");
    }),
  );

  it.live("keeps invalid names, attributes and sampling outside the emitter", () =>
    Effect.gen(function* () {
      const contract: TelemetryContract<TelemetryContractInput> =
        yield* defineTelemetryContract(contractInput);
      const producer = makeEventProducer(contract);
      const invalidName = yield* Testing.run(
        producer
          .emit("Unknown", { outcome: "success", attributes: {} })
          .pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isFailure(invalidName.exit));
      assert.lengthOf(invalidName.telemetry.logs, 0);

      const invalidAttribute = yield* Testing.run(
        producer
          .emit("Exported", {
            outcome: "success",
            attributes: { "contract.fixture": "valid", "contract.extra": true },
          })
          .pipe(Effect.provide(layerWideEvent)),
      );
      assert.isTrue(Exit.isFailure(invalidAttribute.exit));
      assert.lengthOf(invalidAttribute.telemetry.logs, 0);

      const invalidSampling = yield* Effect.flip(
        defineTelemetryContract({
          version: 1,
          events: {
            Invalid: {
              name: "sampling.invalid",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "rate", rate: 0 },
              attributes: {},
            },
          },
          metrics: {},
          auditActions: {},
        }),
      );
      assert.include(
        invalidSampling.issues.map((issue) => issue.code),
        "OBS_CONTRACT_INVALID_SAMPLING_RATE",
      );
    }),
  );
});
