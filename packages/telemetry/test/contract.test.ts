import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import {
  defineEventDefinitions,
  defineTelemetryContract,
  makeEventProducer,
  organizationEvents,
  telemetryContractDefinition,
  type TelemetryContract,
  type TelemetryContractInput,
} from "../src/contract/index.ts";
import {
  contractIssueFixtures,
  makeCollectingTelemetryEventSink,
  organizationEventFixtures,
  withFixedSampling,
} from "../src/testing/contract.ts";

const applicationEvents = defineEventDefinitions({
  DomainChanged: {
    name: "subscription.changed",
    kind: "domain",
    defaultSeverity: "info",
    mandatory: false,
    sampling: { kind: "rate", rate: 0.5 },
    attributes: {
      "subscription.plan": {
        classification: "public",
        required: true,
        metricLabel: true,
      },
    },
  },
  CanaryCompleted: {
    name: "canary.completed",
    kind: "domain",
    defaultSeverity: "info",
    mandatory: true,
    sampling: { kind: "rate", rate: 0.5 },
    attributes: {},
  },
  AuditTracked: {
    name: "access.reviewed",
    kind: "audit",
    defaultSeverity: "info",
    mandatory: false,
    sampling: { kind: "rate", rate: 0.5 },
    attributes: {},
  },
});

const applicationContractInput = telemetryContractDefinition({
  version: 1,
  events: { ...organizationEvents, ...applicationEvents },
  metrics: {},
  auditActions: {
    AccessReviewed: {
      action: "access.reviewed",
      resourceType: "account",
      allowedOutcomes: ["success", "failure"],
    },
  },
});

const compileApplicationContract = defineTelemetryContract(applicationContractInput);

const issueCodes = (error: { readonly issues: ReadonlyArray<{ readonly code: string }> }) =>
  error.issues.map((contractIssue) => contractIssue.code);

describe("defineTelemetryContract", () => {
  it.effect("compiles aliases, canonical names, metrics and audit actions", () =>
    Effect.gen(function* () {
      const contract = yield* compileApplicationContract;
      assert.strictEqual(contract.version, 1);
      assert.strictEqual(contract.eventByAlias.get("BrowserError")?.name, "browser.error");
      assert.strictEqual(contract.eventByName.size, 11);
      assert.strictEqual(
        contract.auditActionByAlias.get("AccessReviewed")?.resourceType,
        "account",
      );
      assert.deepStrictEqual(contract.metrics, {});
    }),
  );

  it.effect("aggregates duplicate names, invalid names, attributes and sampling rates", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        defineTelemetryContract({
          version: 1,
          events: {
            First: {
              name: "payment.failed.production",
              kind: "operation",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "rate", rate: 0 },
              attributes: {
                Undotted: {
                  classification: "sensitive",
                  required: true,
                  metricLabel: true,
                },
              },
            },
            Second: {
              name: "payment.failed.production",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "always" },
              attributes: {},
            },
          },
          metrics: {},
          auditActions: {},
        }),
      );
      assert.strictEqual(error.code, "OBS_CONTRACT_INVALID");
      assert.includeMembers(issueCodes(error), [
        "OBS_CONTRACT_INVALID_EVENT_NAME",
        "OBS_CONTRACT_DUPLICATE_EVENT_NAME",
        "OBS_CONTRACT_INVALID_ATTRIBUTE_NAME",
        "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
        "OBS_CONTRACT_INVALID_SAMPLING_RATE",
      ]);
      assert.include(error.message, "issue(s)");
    }),
  );

  for (const rate of [0, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it.effect(`rejects invalid sampling rate ${String(rate)}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          defineTelemetryContract({
            version: 1,
            events: {
              Sampled: {
                name: "sample.event",
                kind: "domain",
                defaultSeverity: "info",
                mandatory: false,
                sampling: { kind: "rate", rate },
                attributes: {},
              },
            },
            metrics: {},
            auditActions: {},
          }),
        );
        assert.include(issueCodes(error), "OBS_CONTRACT_INVALID_SAMPLING_RATE");
      }),
    );
  }

  const invalidNames = [
    "single",
    "event.production",
    "event.failure",
    "payment.error",
    "api.error.handler",
  ] satisfies ReadonlyArray<
    "single" | "event.production" | "event.failure" | "payment.error" | "api.error.handler"
  >;
  for (const name of invalidNames) {
    it.effect(`rejects invalid event name ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          defineTelemetryContract({
            version: 1,
            events: {
              Invalid: {
                name,
                kind: "domain",
                defaultSeverity: "info",
                mandatory: false,
                sampling: { kind: "always" },
                attributes: {},
              },
            },
            metrics: {},
            auditActions: {},
          }),
        );
        assert.include(issueCodes(error), "OBS_CONTRACT_INVALID_EVENT_NAME");
      }),
    );
  }

  it.effect("rejects five-part and overlong event names", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        defineTelemetryContract({
          version: 1,
          events: {
            FiveParts: {
              name: "too.many.event.name.parts",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "always" },
              attributes: {},
            },
            Overlong: {
              name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "always" },
              attributes: {},
            },
          },
          metrics: {},
          auditActions: {},
        }),
      );
      assert.strictEqual(
        issueCodes(error).filter((code) => code === "OBS_CONTRACT_INVALID_EVENT_NAME").length,
        2,
      );
    }),
  );

  it.effect("reserves the event attribute namespace with a typed issue", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        defineTelemetryContract({
          version: 1,
          events: {
            Invalid: {
              name: "probe.completed",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: true,
              sampling: { kind: "always" },
              attributes: {
                "event.outcome": {
                  classification: "public",
                  required: true,
                  metricLabel: true,
                },
              },
            },
          },
          metrics: {},
          auditActions: {},
        }),
      );
      assert.include(issueCodes(error), "OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME");
      assert.include(contractIssueFixtures, "OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME");
      assert.strictEqual(error.issues[0]?.attributeName, "event.outcome");
    }),
  );

  it.effect("accepts lowercase numbers, underscores and only the browser.error exception", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract({
        version: 1,
        events: {
          Browser: {
            name: "browser.error",
            kind: "defect",
            defaultSeverity: "error",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {
              "error.origin": { classification: "public", required: true, metricLabel: true },
            },
          },
          Worker: {
            name: "worker_2.job_3",
            kind: "operation",
            defaultSeverity: "info",
            mandatory: false,
            sampling: { kind: "always" },
            attributes: {},
          },
        },
        metrics: {},
        auditActions: {},
      });
      assert.deepStrictEqual(contract.eventNames.map(String), ["browser.error", "worker_2.job_3"]);
    }),
  );
});

describe("organization contracts", () => {
  it("exports the eight versioned product-neutral boundary contracts", () => {
    assert.lengthOf(organizationEventFixtures, 8);
    const serialized = JSON.stringify(organizationEventFixtures).toLowerCase();
    for (const deniedName of [
      "hibou",
      "betrybe",
      "betalent",
      "checkout_api",
      "telemetry_testing",
    ]) {
      assert.notInclude(serialized, deniedName);
    }
    assert.deepStrictEqual(
      organizationEventFixtures.map((fixture) => fixture.name),
      [
        "request.completed",
        "dependency.call",
        "llm.call",
        "scheduler.run",
        "queue.job",
        "payment.attempt",
        "usage.recorded",
        "browser.error",
      ],
    );
  });

  it("requires error.origin without duplicating error type or message", () => {
    assert.deepStrictEqual(Object.keys(organizationEvents.BrowserError.attributes), [
      "error.origin",
    ]);
  });
});

describe("contract event producer", () => {
  it.effect("records a valid event and derives its canonical fields", () =>
    Effect.gen(function* () {
      const contract = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const receipt = yield* producer
        .emit("RequestCompleted", {
          outcome: "success",
          durationMs: 12,
          http: { method: "GET", route: "/health", statusCode: 200 },
          attributes: {},
        })
        .pipe(Effect.provide(sink.layer));
      assert.strictEqual(receipt.decision, "recorded");
      const events = yield* sink.events;
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]?.kind, "request");
      assert.strictEqual(events[0]?.name, "request.completed");
      assert.match(events[0]?.timestamp ?? "", /Z$/);
    }),
  );

  it.effect("samples only eligible successful rate events", () =>
    Effect.gen(function* () {
      const contract = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const sampled = yield* withFixedSampling(
        producer
          .emit("DomainChanged", {
            outcome: "success",
            attributes: { "subscription.plan": "team" },
          })
          .pipe(Effect.provide(sink.layer)),
        0.9,
      );
      assert.strictEqual(sampled.decision, "sampled_out");
      const cancelled = yield* withFixedSampling(
        producer
          .emit("DomainChanged", {
            outcome: "cancelled",
            attributes: { "subscription.plan": "team" },
          })
          .pipe(Effect.provide(sink.layer)),
        0.9,
      );
      assert.strictEqual(cancelled.decision, "sampled_out");
      const failure = yield* withFixedSampling(
        producer
          .emit("DomainChanged", {
            outcome: "failure",
            attributes: { "subscription.plan": "team" },
          })
          .pipe(Effect.provide(sink.layer)),
        0.9,
      );
      assert.strictEqual(failure.decision, "recorded");
      const audit = yield* withFixedSampling(
        producer
          .emit("AuditTracked", {
            outcome: "success",
            audit: {
              action: "access.reviewed",
              actor: { kind: "system" },
              resourceType: "account",
              resourceId: "account-1",
            },
            attributes: {},
          })
          .pipe(Effect.provide(sink.layer)),
        0.9,
      );
      assert.strictEqual(audit.decision, "recorded");
      const canary = yield* withFixedSampling(
        producer
          .emit("CanaryCompleted", { outcome: "success", attributes: {} })
          .pipe(Effect.provide(sink.layer)),
        0.9,
      );
      assert.strictEqual(canary.decision, "recorded");
      assert.lengthOf(yield* sink.events, 3);
    }),
  );

  it.effect(
    "rejects unknown aliases, undeclared attributes and invalid fields before the sink",
    () =>
      Effect.gen(function* () {
        const contract: TelemetryContract<TelemetryContractInput> =
          yield* compileApplicationContract;
        const sink = yield* makeCollectingTelemetryEventSink();
        const producer = makeEventProducer(contract);
        const unknownAlias = yield* producer
          .emit("MissingAlias", { outcome: "success", attributes: {} })
          .pipe(Effect.provide(sink.layer), Effect.exit);
        assert.isTrue(Exit.isFailure(unknownAlias));
        const undeclared = yield* producer
          .emit("DomainChanged", {
            outcome: "success",
            attributes: { "subscription.plan": "team", "subscription.secret": "no" },
          })
          .pipe(Effect.provide(sink.layer), Effect.exit);
        assert.isTrue(Exit.isFailure(undeclared));
        const invalidDuration = yield* producer
          .emit("RequestCompleted", {
            outcome: "success",
            durationMs: Number.NaN,
            http: { method: "GET", route: "/", statusCode: 200 },
            attributes: {},
          })
          .pipe(Effect.provide(sink.layer), Effect.exit);
        assert.isTrue(Exit.isFailure(invalidDuration));
        assert.lengthOf(yield* sink.events, 0);
      }),
  );

  it.effect("rejects missing required attributes and non-UTC timestamps before the sink", () =>
    Effect.gen(function* () {
      const contract: TelemetryContract<TelemetryContractInput> = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const missing = yield* producer
        .emit("DomainChanged", { outcome: "success", attributes: {} })
        .pipe(Effect.provide(sink.layer), Effect.exit);
      assert.isTrue(Exit.isFailure(missing));
      const timestamp = yield* producer
        .emit("DomainChanged", {
          outcome: "success",
          timestamp: "2026-01-01T00:00:00+00:00",
          attributes: { "subscription.plan": "team" },
        })
        .pipe(Effect.provide(sink.layer), Effect.exit);
      assert.isTrue(Exit.isFailure(timestamp));
      assert.lengthOf(yield* sink.events, 0);
    }),
  );

  it.effect("fixes defect outcomes to failure", () =>
    Effect.gen(function* () {
      const contract = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const receipt = yield* producer
        .emit("BrowserError", {
          error: { type: "TypeError", message: "failed", retryable: false },
          attributes: { "error.origin": "browser" },
          correlation: Option.none(),
        })
        .pipe(Effect.provide(sink.layer));
      assert.strictEqual(receipt.decision, "recorded");
      if (receipt.decision === "recorded") {
        assert.strictEqual(receipt.event.outcome, "failure");
      }
    }),
  );
});
