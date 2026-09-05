import { Effect } from "effect";
import { defineTelemetryContract, generateRunId, type RunId, Telemetry } from "../../src/index.ts";
import * as Observability from "../../src/index.ts";
import { createMetrics, MetricsError } from "../../src/Metrics.ts";
import { ingestBrowserEvents } from "../../src/node/index.ts";
import type { TelemetryConfig } from "../../src/TelemetryConfig.ts";
import type { InvalidDataPolicy } from "../../src/policy/DataPolicyError.ts";
import * as WideEvent from "../../src/effect/WideEvent.ts";
import { layerWideEvent } from "../../src/effect/WideEventSink.ts";

export const canaryRunId = (): Effect.Effect<RunId> =>
  generateRunId("canary", process.env["USER"] ?? "ci");

const canaryContract = await Effect.runPromise(
  defineTelemetryContract({
    version: 1,
    events: {},
    metrics: {
      CanaryOperations: {
        name: "canary.operations",
        description: "Completed observability canary operations",
        unit: "1",
        kind: "counter",
        attributes: {
          "canary.run_id": {
            classification: "internal",
            maximumCardinality: 100,
          },
        },
      },
      CanaryMetricRedactionProbe: {
        name: "canary.redaction_probe",
        description: "Rejected sensitive metric labels",
        unit: "1",
        kind: "counter",
        attributes: {
          "canary.run_id": { classification: "internal", maximumCardinality: 100 },
          "canary.probe_a": { classification: "internal", maximumCardinality: 100 },
          "canary.probe_b": { classification: "internal", maximumCardinality: 100 },
          "canary.probe_c": { classification: "internal", maximumCardinality: 100 },
          "canary.probe_d": { classification: "internal", maximumCardinality: 100 },
          "canary.probe_e": { classification: "internal", maximumCardinality: 100 },
        },
      },
    },
    auditActions: {},
  }),
);

export const canarySensitiveValues = (runId: string) => {
  const compactRunId = runId.replaceAll("-", "");
  const authorizationMarker = `authorizationmarker${compactRunId}`;
  const passwordMarker = `passwordmarker${compactRunId}`;
  const tokenMarker = `tokenmarker${compactRunId}`;
  const emailMarker = `emailmarker${compactRunId}`;
  const accessTokenMarker = `accesstokenmarker${compactRunId}`;
  const userPasswordMarker = `userpasswordmarker${compactRunId}`;
  const phoneNumberMarker = `phonenumbermarker${compactRunId}`;
  const rawAuthorizationMarker = `rawauthorizationmarker${compactRunId}`;
  const nestedAssignmentMarker = `nestedassignmentmarker${compactRunId}`;
  const authorization = `Bearer ${authorizationMarker}`;
  const rawAuthorization = `authorization: Bearer ${rawAuthorizationMarker} authorization: Bearer ${rawAuthorizationMarker}`;
  const password = `opaque-${passwordMarker}-value`;
  const token = `sk-${tokenMarker}`;
  const email = `${emailMarker}@example.test`;
  const accessToken = `opaque-${accessTokenMarker}-value`;
  const userPassword = `prefix"${userPasswordMarker}`;
  const phoneNumber = `opaque-${phoneNumberMarker}-value`;
  const tokenizerValue = `tokenizercontrol${compactRunId}`;
  const documentationValue = `documentationcontrol${compactRunId}`;
  const nestedAssignments = [
    `https://api.x/login?password=${nestedAssignmentMarker}`,
    `url=https://api.x/cb?token=${nestedAssignmentMarker}`,
    `a=1&password=${nestedAssignmentMarker}&b=2`,
    `note="token=${nestedAssignmentMarker}" safe=1`,
    `data[password]=${nestedAssignmentMarker}`,
    `authorization: Basic ${nestedAssignmentMarker} ${nestedAssignmentMarker}`,
    `authorization: Digest username=${nestedAssignmentMarker}, response=${nestedAssignmentMarker}`,
    `cookie: sid=${nestedAssignmentMarker}; csrf=${nestedAssignmentMarker}; theme=dark`,
    `password: my ${nestedAssignmentMarker} pass phrase`,
    `token =${nestedAssignmentMarker}`,
    `'password': '${nestedAssignmentMarker}'`,
    `"password" = '${nestedAssignmentMarker}'`,
    "`password`: `" + nestedAssignmentMarker + "`",
    `error sending 'token': "${nestedAssignmentMarker}"`,
    `{'password': '${nestedAssignmentMarker}'}`,
    `password=${nestedAssignmentMarker}&more`,
    `password=${nestedAssignmentMarker}#fragment`,
    `password=${nestedAssignmentMarker}&safe=1`,
    `password=${nestedAssignmentMarker}#safe:1`,
    `password=${nestedAssignmentMarker}&token=${nestedAssignmentMarker}`,
  ];
  return {
    authorization,
    password,
    token,
    email,
    accessToken,
    userPassword,
    phoneNumber,
    rawAuthorization,
    leakMarkers: [
      authorizationMarker,
      passwordMarker,
      tokenMarker,
      emailMarker,
      accessTokenMarker,
      userPasswordMarker,
      phoneNumberMarker,
      rawAuthorizationMarker,
      nestedAssignmentMarker,
    ],
    tokenizerValue,
    documentationValue,
    preservedValues: [tokenizerValue, documentationValue],
    nestedAssignments,
    serializedBody: JSON.stringify({
      authorization,
      password,
      token,
      email,
      accessToken,
      userPassword,
      phoneNumber,
      tokenizer: tokenizerValue,
      documentation: documentationValue,
    }),
  };
};

export const emitCanary = (
  config: TelemetryConfig,
  runId: string,
): Effect.Effect<void, InvalidDataPolicy> => {
  const sensitive = canarySensitiveValues(runId);
  const nestedAttributes = Object.fromEntries(
    sensitive.nestedAssignments.map((value, index) => [`safe.nested_${index}`, value]),
  );
  const sensitiveAttributes = {
    "canary.run_id": runId,
    ...nestedAttributes,
    "http.authorization": sensitive.authorization,
    "user.password": sensitive.password,
    "auth.access_token": sensitive.accessToken,
    "profile.password": sensitive.userPassword,
    "contact.phone": sensitive.phoneNumber,
    "tool.tokenizer": sensitive.tokenizerValue,
    "docs.documentation": sensitive.documentationValue,
    "safe.message": `token=${sensitive.token} email=${sensitive.email}`,
    "safe.raw_header": sensitive.rawAuthorization,
  };
  return Effect.gen(function* () {
    const metrics = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createMetrics({
          serviceName: config.identity.serviceName,
          serviceVersion: config.identity.serviceVersion,
          environment: config.identity.environment,
          deploymentEnvironmentAlias: config.environmentAlias,
          otlpEndpoint: config.otlpEndpoint.toString(),
        }),
      ),
      (facade) => Effect.promise(() => facade.close()).pipe(Effect.orDie),
    );
    const metricProducer = Observability.makeMetricProducer(canaryContract, metrics);
    const operationCounter = metricProducer.counter("CanaryOperations");
    const redactionProbe = metricProducer.counter("CanaryMetricRedactionProbe");
    yield* Effect.sleep("10 millis").pipe(Effect.withSpan("canary.child"));
    yield* WideEvent.emit("canary.completed", {
      "canary.run_id": runId,
      ...nestedAttributes,
    });
    yield* Effect.logInfo(sensitive.rawAuthorization).pipe(
      Effect.annotateLogs({
        "canary.run_id": runId,
        "event.name": "canary.raw_header",
        "event.kind": "wide",
        "safe.raw_header": sensitive.rawAuthorization,
      }),
    );
    yield* Effect.logInfo(sensitive.serializedBody).pipe(
      Effect.annotateLogs({
        ...sensitiveAttributes,
        "event.name": "canary.redaction",
        "event.kind": "wide",
      }),
    );
    const browserTraceId = crypto.randomUUID().replaceAll("-", "");
    const browserRootSpanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const browserChildSpanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const browserStartedAt = Date.now();
    yield* ingestBrowserEvents({
      version: 1,
      resource: {
        serviceName: config.identity.serviceName,
        serviceVersion: config.identity.serviceVersion,
        environment: config.identity.environment,
      },
      events: [
        {
          id: `browser-${runId}`,
          name: "canary.browser",
          occurredAt: Date.now(),
          trace: { traceId: browserTraceId, spanId: browserChildSpanId },
          fields: {
            "canary.run_id": runId,
            "safe.raw_header": sensitive.rawAuthorization,
            ...nestedAttributes,
          },
        },
      ],
      spans: [
        {
          traceId: browserTraceId,
          spanId: browserRootSpanId,
          name: "canary.browser.operation",
          startedAt: browserStartedAt,
          endedAt: Date.now(),
          fields: { "canary.run_id": runId },
        },
        {
          traceId: browserTraceId,
          spanId: browserChildSpanId,
          parentSpanId: browserRootSpanId,
          name: "canary.browser.child",
          startedAt: browserStartedAt,
          endedAt: Date.now(),
          fields: { "canary.run_id": runId },
        },
      ],
      metrics: [
        {
          name: "canary.browser.operations",
          value: 1,
          occurredAt: Date.now(),
          fields: { "canary.run_id": runId },
        },
      ],
    }).pipe(Effect.provide(layerWideEvent), Effect.orDie);
    yield* Effect.sync(() => {
      try {
        redactionProbe.add(1, {
          "canary.run_id": runId,
          "canary.probe_a": sensitive.authorization,
          "canary.probe_b": sensitive.password,
          "canary.probe_c": sensitive.accessToken,
          "canary.probe_d": sensitive.email,
          "canary.probe_e": sensitive.phoneNumber,
        });
        throw new Error("Expected sensitive metric labels to be rejected.");
      } catch (cause) {
        if (!(cause instanceof MetricsError) || cause.code !== "POLICY_BLOCKED") throw cause;
      }
    });
    operationCounter.add(1, { "canary.run_id": runId });
  }).pipe(
    Effect.scoped,
    Effect.withSpan("canary.operation", { attributes: sensitiveAttributes }),
    Effect.provide(Telemetry.layer(config)),
  );
};
