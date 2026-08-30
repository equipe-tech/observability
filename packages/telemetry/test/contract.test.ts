import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { CorrelationContext } from "../src/Correlation.ts";
import {
  defineEventDefinitions,
  defineTelemetryContract,
  InvalidTelemetryEvent,
  isValidEventName,
  makeEventProducer,
  organizationContractVersion,
  organizationEvents,
  telemetryContractDefinition,
  validateContractEvent,
  type AttributeDefinitionsInput,
  type TelemetryContract,
  type TelemetryContractInput,
} from "../src/contract/index.ts";
import {
  contractIssueFixtures,
  makeCollectingTelemetryEventSink,
  organizationEventFixtures,
  telemetryEventErrorFixtures,
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
  it("exports every reachable contract issue code", () => {
    assert.sameMembers(Array.from(contractIssueFixtures), [
      "OBS_CONTRACT_INVALID_DOCUMENT",
      "OBS_CONTRACT_INVALID_VERSION",
      "OBS_CONTRACT_INVALID_EVENT_NAME",
      "OBS_CONTRACT_DUPLICATE_EVENT_NAME",
      "OBS_CONTRACT_INVALID_EVENT_KIND",
      "OBS_CONTRACT_INVALID_DEFAULT_SEVERITY",
      "OBS_CONTRACT_INVALID_ATTRIBUTE_NAME",
      "OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME",
      "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
      "OBS_CONTRACT_INVALID_SAMPLING_RATE",
      "OBS_CONTRACT_INVALID_AUDIT_ACTION",
      "OBS_CONTRACT_DUPLICATE_AUDIT_ACTION",
    ]);
  });

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
      const duplicate = error.issues.find(
        (entry) => entry.code === "OBS_CONTRACT_DUPLICATE_EVENT_NAME",
      );
      assert.strictEqual(duplicate?.eventAlias, "Second");
      assert.strictEqual(duplicate?.eventName, "payment.failed.production");
      assert.include(duplicate?.message ?? "", "declared by aliases");
    }),
  );

  it.effect("rejects duplicate canonical audit actions with an exact issue", () =>
    Effect.gen(function* () {
      const error = yield* defineTelemetryContract(
        JSON.parse(`{
          "version": 1,
          "events": {},
          "metrics": {},
          "auditActions": {
            "AccountReviewed": {
              "action": "access.reviewed",
              "resourceType": "account",
              "allowedOutcomes": ["success"]
            },
            "InvoiceReviewed": {
              "action": "access.reviewed",
              "resourceType": "invoice",
              "allowedOutcomes": ["failure"]
            }
          }
        }`),
      ).pipe(Effect.flip);
      assert.strictEqual(error.code, "OBS_CONTRACT_INVALID");
      assert.deepStrictEqual(error.issues, [
        {
          code: "OBS_CONTRACT_DUPLICATE_AUDIT_ACTION",
          message:
            'Audit action "access.reviewed" is declared by aliases "AccountReviewed" and "InvoiceReviewed". Give each audit action one canonical name.',
          auditActionAlias: "InvoiceReviewed",
          auditActionName: "access.reviewed",
        },
      ]);
    }),
  );

  it.effect("rejects required and metric flags for every restricted classification", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        defineTelemetryContract({
          version: 1,
          events: {
            Restricted: {
              name: "profile.updated",
              kind: "domain",
              defaultSeverity: "info",
              mandatory: false,
              sampling: { kind: "always" },
              attributes: {
                "profile.sensitive_required": {
                  classification: "sensitive",
                  required: true,
                  metricLabel: false,
                },
                "profile.sensitive_metric": {
                  classification: "sensitive",
                  required: false,
                  metricLabel: true,
                },
                "profile.forbidden_required": {
                  classification: "forbidden",
                  required: true,
                  metricLabel: false,
                },
                "profile.forbidden_metric": {
                  classification: "forbidden",
                  required: false,
                  metricLabel: true,
                },
              },
            },
          },
          metrics: {},
          auditActions: {},
        }),
      );
      const restrictedIssues = error.issues.filter(
        (entry) => entry.code === "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
      );
      assert.sameMembers(
        restrictedIssues.map((entry) => entry.attributeName),
        [
          "profile.sensitive_required",
          "profile.sensitive_metric",
          "profile.forbidden_required",
          "profile.forbidden_metric",
        ],
      );
      assert.strictEqual(restrictedIssues.length, 4);
      for (const contractIssue of restrictedIssues) {
        assert.include(contractIssue.message, "set required and metricLabel to false");
      }
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
      assert.include(error.issues[0]?.message ?? "", "canonical sink field");
    }),
  );

  it.effect("rejects malformed outer input with a typed document issue", () =>
    Effect.gen(function* () {
      const error = yield* defineTelemetryContract(JSON.parse("{}")).pipe(Effect.flip);
      assert.strictEqual(error.code, "OBS_CONTRACT_INVALID");
      assert.strictEqual(
        error.message,
        "Telemetry contract has an invalid outer document. Provide version, events, metrics, and auditActions records.",
      );
      assert.deepStrictEqual(error.issues, [
        {
          code: "OBS_CONTRACT_INVALID_DOCUMENT",
          message:
            "Telemetry contract document is malformed. Provide version, events, metrics, and auditActions records.",
        },
      ]);
      const nested = yield* defineTelemetryContract(
        JSON.parse('{"version":1,"events":{"Broken":null},"metrics":{},"auditActions":{}}'),
      ).pipe(Effect.flip);
      assert.strictEqual(nested.issues[0]?.code, "OBS_CONTRACT_INVALID_DOCUMENT");
    }),
  );

  it.effect("validates default severity and every exact canonical sink field", () =>
    Effect.gen(function* () {
      const canonicalFields = [
        "event.name",
        "event.kind",
        "event.type",
        "event.severity",
        "event.outcome",
        "event.timestamp",
        "event.duration_ms",
        "http.request.method",
        "http.route",
        "http.response.status_code",
        "error.type",
        "error.message",
        "error.retryable",
        "audit.action",
        "audit.actor.kind",
        "audit.actor.id",
        "audit.resource.type",
        "audit.resource.id",
        "request.id",
        "run.id",
      ];
      const attributes = Object.fromEntries(
        canonicalFields.map((name) => [
          name,
          { classification: "public", required: false, metricLabel: false },
        ]),
      );
      attributes["http.application_field"] = {
        classification: "public",
        required: false,
        metricLabel: false,
      };
      const error = yield* defineTelemetryContract(
        JSON.parse(
          JSON.stringify({
            version: 1,
            events: {
              Invalid: {
                name: "probe.completed",
                kind: "domain",
                defaultSeverity: "notice",
                mandatory: true,
                sampling: { kind: "always" },
                attributes,
              },
            },
            metrics: {},
            auditActions: {},
          }),
        ),
      ).pipe(Effect.flip);
      assert.include(issueCodes(error), "OBS_CONTRACT_INVALID_DEFAULT_SEVERITY");
      assert.strictEqual(
        error.issues.filter((entry) => entry.code === "OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME")
          .length,
        canonicalFields.length,
      );
      assert.notInclude(
        error.issues.map((entry) => entry.attributeName),
        "http.application_field",
      );
    }),
  );

  it.effect("rejects invalid contract issue categories with safe context", () =>
    Effect.gen(function* () {
      const error = yield* defineTelemetryContract(
        JSON.parse(`{
        "version": 2,
        "events": {
          "Bad": {
            "name": "event.production",
            "kind": "other",
            "defaultSeverity": "notice",
            "mandatory": false,
            "sampling": { "kind": "rate", "rate": 0 },
            "attributes": {
              "bad": { "classification": "sensitive", "required": true, "metricLabel": true }
            }
          }
        },
        "metrics": { "FutureMetric": { "opaque": true } },
        "auditActions": {
          "BadAction": { "action": "BAD", "resourceType": "", "allowedOutcomes": ["unknown"] }
        }
      }`),
      ).pipe(Effect.flip);
      assert.sameMembers(issueCodes(error), [
        "OBS_CONTRACT_INVALID_VERSION",
        "OBS_CONTRACT_INVALID_EVENT_NAME",
        "OBS_CONTRACT_INVALID_EVENT_KIND",
        "OBS_CONTRACT_INVALID_DEFAULT_SEVERITY",
        "OBS_CONTRACT_INVALID_SAMPLING_RATE",
        "OBS_CONTRACT_INVALID_ATTRIBUTE_NAME",
        "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
        "OBS_CONTRACT_INVALID_AUDIT_ACTION",
      ]);
      const messageFragments = new Map([
        ["OBS_CONTRACT_INVALID_VERSION", "version is invalid"],
        ["OBS_CONTRACT_INVALID_EVENT_NAME", "is invalid"],
        ["OBS_CONTRACT_INVALID_EVENT_KIND", "invalid kind"],
        ["OBS_CONTRACT_INVALID_DEFAULT_SEVERITY", "invalid default severity"],
        ["OBS_CONTRACT_INVALID_SAMPLING_RATE", "invalid sampling rate"],
        ["OBS_CONTRACT_INVALID_ATTRIBUTE_NAME", "is invalid"],
        [
          "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
          "invalid classification or incompatible flags",
        ],
        ["OBS_CONTRACT_INVALID_AUDIT_ACTION", "is invalid"],
      ]);
      for (const entry of error.issues) {
        assert.include(entry.message, messageFragments.get(entry.code) ?? "unreachable");
      }
      const eventIssue = error.issues.find(
        (entry) => entry.code === "OBS_CONTRACT_INVALID_EVENT_KIND",
      );
      assert.strictEqual(eventIssue?.eventAlias, "Bad");
      assert.strictEqual(eventIssue?.eventName, "event.production");
      const auditIssue = error.issues.find(
        (entry) => entry.code === "OBS_CONTRACT_INVALID_AUDIT_ACTION",
      );
      assert.strictEqual(auditIssue?.auditActionAlias, "BadAction");
    }),
  );

  it.effect("accepts ordinary words while rejecting identifier segments", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract({
        version: 1,
        events: {
          Decade: {
            name: "billing.decade",
            kind: "domain",
            defaultSeverity: "info",
            mandatory: false,
            sampling: { kind: "always" },
            attributes: {},
          },
          Facade: {
            name: "cache.facade",
            kind: "domain",
            defaultSeverity: "info",
            mandatory: false,
            sampling: { kind: "always" },
            attributes: {},
          },
        },
        metrics: {},
        auditActions: {},
      });
      assert.lengthOf(contract.eventNames, 2);
      for (const name of [
        "job.12345",
        "job.550e8400_e29b_41d4_a716_446655440000",
        "job.customer1234567890",
      ]) {
        assert.isFalse(isValidEventName(name));
      }
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
  it("exports the independent version identity and eight product-neutral boundary contracts", () => {
    assert.strictEqual(organizationContractVersion, 1);
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
  it.effect("returns typed failures for malformed, reserved, and unknown event names", () =>
    Effect.gen(function* () {
      const contract = yield* compileApplicationContract;
      for (const eventName of ["Invalid Name", "job.error", "job.unknown"]) {
        const result = validateContractEvent(contract, eventName, {});
        assert.instanceOf(result, InvalidTelemetryEvent);
        assert.strictEqual(result.code, "OBS_EVENT_UNKNOWN_NAME");
        assert.include(result.message, "Use a valid declared canonical event name");
        assert.notInclude(result.message, "Schema");
      }
    }),
  );

  it("exports every reachable event error code", () => {
    assert.sameMembers(Array.from(telemetryEventErrorFixtures), [
      "OBS_EVENT_UNKNOWN_NAME",
      "OBS_EVENT_UNDECLARED_ATTRIBUTE",
      "OBS_EVENT_MISSING_ATTRIBUTE",
      "OBS_EVENT_INVALID_FIELD",
      "OBS_EVENT_INVALID_OUTCOME",
      "OBS_EVENT_RESTRICTED_ATTRIBUTE",
      "OBS_EVENT_SENSITIVE_METRIC_LABEL",
      "OBS_EVENT_UNKNOWN_AUDIT_ACTION",
      "OBS_EVENT_INVALID_AUDIT_RESOURCE",
      "OBS_EVENT_INVALID_AUDIT_OUTCOME",
    ]);
  });

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

  it.effect("returns discriminated errors for aliases and attributes before the sink", () =>
    Effect.gen(function* () {
      const contract: TelemetryContract<TelemetryContractInput> = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const unknownAlias = yield* producer
        .emit("MissingAlias", { outcome: "success", attributes: {} })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.deepStrictEqual(
        {
          code: unknownAlias.code,
          eventAlias: unknownAlias.eventAlias,
          eventName: unknownAlias.eventName,
          attributeName: unknownAlias.attributeName,
        },
        {
          code: "OBS_EVENT_UNKNOWN_NAME",
          eventAlias: "MissingAlias",
          eventName: undefined,
          attributeName: undefined,
        },
      );
      assert.include(unknownAlias.message, "not declared");
      const undeclared = yield* producer
        .emit("DomainChanged", {
          outcome: "success",
          attributes: { "subscription.plan": "team", "subscription.secret": "no" },
        })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.strictEqual(undeclared.code, "OBS_EVENT_UNDECLARED_ATTRIBUTE");
      assert.strictEqual(undeclared.eventName, "subscription.changed");
      assert.strictEqual(undeclared.attributeName, "subscription.secret");
      assert.include(undeclared.message, "does not declare");
      const missing = yield* producer
        .emit("DomainChanged", { outcome: "success", attributes: {} })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.strictEqual(missing.code, "OBS_EVENT_MISSING_ATTRIBUTE");
      assert.strictEqual(missing.eventName, "subscription.changed");
      assert.strictEqual(missing.attributeName, "subscription.plan");
      assert.include(missing.message, "missing required attribute");
      assert.lengthOf(yield* sink.events, 0);
    }),
  );

  it.effect("rejects malformed whole payloads as typed failures", () =>
    Effect.gen(function* () {
      const contract: TelemetryContract<TelemetryContractInput> = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const invalidPayloadMessage =
        'Event "subscription.changed" has an invalid payload. Use an event payload object with declared fields.';
      const malformedPayloads = [
        { payload: JSON.parse("null"), attributeName: "payload", message: invalidPayloadMessage },
        {
          payload: JSON.parse("{}").missing,
          attributeName: "payload",
          message: invalidPayloadMessage,
        },
        { payload: JSON.parse("[]"), attributeName: "payload", message: invalidPayloadMessage },
        {
          payload: JSON.parse('"invalid"'),
          attributeName: "payload",
          message: invalidPayloadMessage,
        },
        {
          payload: JSON.parse("{}"),
          attributeName: "attributes",
          message:
            'Event "subscription.changed" has invalid attributes. Use a declared scalar attribute object.',
        },
      ];
      for (const testCase of malformedPayloads) {
        const exit = yield* producer
          .emit("DomainChanged", testCase.payload)
          .pipe(Effect.provide(sink.layer), Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isSuccess(exit)) {
          assert.fail("Malformed payload unexpectedly succeeded");
        }
        const failure = Cause.findErrorOption(exit.cause);
        assert.isTrue(Option.isSome(failure));
        if (Option.isNone(failure)) {
          assert.fail("Malformed payload produced a defect instead of a typed failure");
        }
        assert.deepStrictEqual(
          {
            code: failure.value.code,
            message: failure.value.message,
            eventName: failure.value.eventName,
            eventAlias: failure.value.eventAlias,
            attributeName: failure.value.attributeName,
          },
          {
            code: "OBS_EVENT_INVALID_FIELD",
            message: testCase.message,
            eventName: "subscription.changed",
            eventAlias: undefined,
            attributeName: testCase.attributeName,
          },
        );
      }
      assert.lengthOf(yield* sink.events, 0);
    }),
  );

  it.effect("parses timestamp, duration, outcome, severity and nested contexts", () =>
    Effect.gen(function* () {
      const contract: TelemetryContract<TelemetryContractInput> = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const cases = [
        {
          alias: "RequestCompleted",
          payload: {
            outcome: "success",
            durationMs: 1,
            http: { method: "", route: "/", statusCode: 200 },
            attributes: {},
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "http",
        },
        {
          alias: "RequestCompleted",
          payload: {
            outcome: "success",
            durationMs: Number.NaN,
            http: { method: "GET", route: "/", statusCode: 200 },
            attributes: {},
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "event.duration_ms",
        },
        {
          alias: "DomainChanged",
          payload: {
            outcome: "success",
            timestamp: "2026-02-30T00:00:00Z",
            attributes: { "subscription.plan": "team" },
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "event.timestamp",
        },
        {
          alias: "DomainChanged",
          payload: {
            outcome: "unknown",
            attributes: { "subscription.plan": "team" },
          },
          code: "OBS_EVENT_INVALID_OUTCOME",
          field: "event.outcome",
        },
        {
          alias: "DomainChanged",
          payload: {
            outcome: "success",
            severity: "notice",
            attributes: { "subscription.plan": "team" },
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "event.severity",
        },
        {
          alias: "DomainChanged",
          payload: {
            outcome: "success",
            correlation: { _id: "Option", _tag: "Some", value: { requestId: "bad" } },
            attributes: { "subscription.plan": "team" },
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "correlation",
        },
        {
          alias: "BrowserError",
          payload: {
            error: { type: "", message: "failed", retryable: false },
            attributes: { "error.origin": "browser" },
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "error",
        },
        {
          alias: "AuditTracked",
          payload: {
            outcome: "success",
            audit: {
              action: "access.reviewed",
              actor: { kind: "user", id: "" },
              resourceType: "account",
              resourceId: "account-1",
            },
            attributes: {},
          },
          code: "OBS_EVENT_INVALID_FIELD",
          field: "audit",
        },
      ];
      for (const testCase of cases) {
        const error = yield* producer
          .emit(testCase.alias, JSON.parse(JSON.stringify(testCase.payload)))
          .pipe(Effect.provide(sink.layer), Effect.flip);
        assert.strictEqual(error.code, testCase.code);
        assert.strictEqual(error.attributeName, testCase.field);
        assert.isNotEmpty(error.message);
        assert.isNotEmpty(error.eventName);
      }
      assert.lengthOf(yield* sink.events, 0);
    }),
  );

  it.effect("rejects unsafe attributes before recording", () =>
    Effect.gen(function* () {
      const contract = yield* defineTelemetryContract({
        version: 1,
        events: {
          Unsafe: {
            name: "profile.updated",
            kind: "domain",
            defaultSeverity: "info",
            mandatory: true,
            sampling: { kind: "always" },
            attributes: {
              "patient.diagnosis": {
                classification: "sensitive",
                required: false,
                metricLabel: false,
              },
              "profile.password": {
                classification: "forbidden",
                required: false,
                metricLabel: false,
              },
            },
          },
        },
        metrics: {},
        auditActions: {},
      });
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const sensitive = yield* producer
        .emit("Unsafe", {
          outcome: "success",
          attributes: { "patient.diagnosis": "private" },
        })
        .pipe(Effect.provide(sink.layer));
      assert.strictEqual(sensitive.decision, "recorded");
      if (sensitive.decision === "recorded") {
        assert.strictEqual(sensitive.event.attributes["patient.diagnosis"], "****");
        assert.deepStrictEqual(sensitive.redactions, [
          { rule: "classification", action: "masked", surface: "event" },
        ]);
      }
      const error = yield* producer
        .emit("Unsafe", {
          outcome: "success",
          attributes: { "profile.password": "secret" },
        })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.include(telemetryEventErrorFixtures, "OBS_EVENT_RESTRICTED_ATTRIBUTE");
      assert.strictEqual(error.code, "OBS_EVENT_RESTRICTED_ATTRIBUTE");
      assert.strictEqual(error.eventName, "profile.updated");
      assert.strictEqual(error.attributeName, "profile.password");
      assert.include(error.message, "cannot emit");
      assert.lengthOf(yield* sink.events, 1);
    }),
  );

  it.effect("bounds the whole server event to 128 attributes", () =>
    Effect.gen(function* () {
      const attributes: AttributeDefinitionsInput = Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field.value${index}`,
          { classification: "public", required: false, metricLabel: false },
        ]),
      );
      const events = defineEventDefinitions({
        Bounded: {
          name: "contract.bounded",
          kind: "domain",
          defaultSeverity: "info",
          mandatory: true,
          sampling: { kind: "always" },
          attributes,
        },
      });
      const contract = yield* defineTelemetryContract({
        version: 1,
        events,
        metrics: {},
        auditActions: {},
      });
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const receipt = yield* producer
        .emit("Bounded", {
          outcome: "success",
          attributes: Object.fromEntries(
            Array.from({ length: 200 }, (_, index) => [`field.value${index}`, index]),
          ),
        })
        .pipe(Effect.provide(sink.layer));
      assert.strictEqual(receipt.decision, "recorded");
      if (receipt.decision === "recorded") {
        assert.strictEqual(Object.keys(receipt.event.attributes).length, 128);
        assert.strictEqual(
          receipt.redactions.filter(
            (redaction) => redaction.rule === "bounds" && redaction.action === "dropped",
          ).length,
          72,
        );
      }
    }),
  );

  it.effect("enforces audit actions, resource types and outcomes", () =>
    Effect.gen(function* () {
      const contract: TelemetryContract<TelemetryContractInput> = yield* compileApplicationContract;
      const sink = yield* makeCollectingTelemetryEventSink();
      const producer = makeEventProducer(contract);
      const unknownAction = yield* producer
        .emit("AuditTracked", {
          outcome: "success",
          audit: {
            action: "access.unknown",
            actor: { kind: "system" },
            resourceType: "account",
            resourceId: "account-1",
          },
          attributes: {},
        })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.strictEqual(unknownAction.code, "OBS_EVENT_UNKNOWN_AUDIT_ACTION");
      assert.strictEqual(unknownAction.eventName, "access.reviewed");
      assert.strictEqual(unknownAction.attributeName, "audit.action");
      assert.include(unknownAction.message, "undeclared action");
      const wrongResource = yield* producer
        .emit("AuditTracked", {
          outcome: "success",
          audit: {
            action: "access.reviewed",
            actor: { kind: "system" },
            resourceType: "workspace",
            resourceId: "workspace-1",
          },
          attributes: {},
        })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.strictEqual(wrongResource.code, "OBS_EVENT_INVALID_AUDIT_RESOURCE");
      assert.strictEqual(wrongResource.eventName, "access.reviewed");
      assert.strictEqual(wrongResource.attributeName, "audit.resource.type");
      assert.include(wrongResource.message, "requires resource type");
      const wrongOutcome = yield* producer
        .emit("AuditTracked", {
          outcome: "cancelled",
          audit: {
            action: "access.reviewed",
            actor: { kind: "system" },
            resourceType: "account",
            resourceId: "account-1",
          },
          attributes: {},
        })
        .pipe(Effect.provide(sink.layer), Effect.flip);
      assert.strictEqual(wrongOutcome.code, "OBS_EVENT_INVALID_AUDIT_OUTCOME");
      assert.strictEqual(wrongOutcome.eventName, "access.reviewed");
      assert.strictEqual(wrongOutcome.attributeName, "event.outcome");
      assert.include(wrongOutcome.message, "does not allow outcome");
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
          correlation: CorrelationContext.make({}),
        })
        .pipe(Effect.provide(sink.layer));
      assert.strictEqual(receipt.decision, "recorded");
      if (receipt.decision === "recorded") {
        assert.strictEqual(receipt.event.outcome, "failure");
      }
    }),
  );
});
