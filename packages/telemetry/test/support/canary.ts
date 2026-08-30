import { Effect, Metric } from "effect";
import { generateRunId, type RunId, Telemetry } from "../../src/index.ts";
import { ingestBrowserEvents } from "../../src/node/index.ts";
import type { TelemetryConfig } from "../../src/TelemetryConfig.ts";
import type { InvalidDataPolicy } from "../../src/policy/DataPolicyError.ts";
import * as WideEvent from "../../src/WideEvent.ts";

export const canaryRunId = (): Effect.Effect<RunId> =>
  generateRunId("canary", process.env["USER"] ?? "ci");

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
    ],
    tokenizerValue,
    documentationValue,
    preservedValues: [tokenizerValue, documentationValue],
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
  const sensitiveAttributes = {
    "canary.run_id": runId,
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
    const operationCounter = Metric.counter("canary.operations", {
      attributes: sensitiveAttributes,
    });
    yield* Effect.sleep("10 millis").pipe(Effect.withSpan("canary.child"));
    yield* WideEvent.emit("canary.completed", { "canary.run_id": runId });
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
    yield* ingestBrowserEvents({
      version: 1,
      events: [
        {
          id: `browser-${runId}`,
          name: "canary.browser",
          occurredAt: Date.now(),
          fields: {
            "canary.run_id": runId,
            "safe.raw_header": sensitive.rawAuthorization,
          },
        },
      ],
    }).pipe(Effect.orDie);
    yield* Metric.update(operationCounter, 1);
  }).pipe(
    Effect.withSpan("canary.operation", { attributes: sensitiveAttributes }),
    Effect.provide(Telemetry.layer(config)),
  );
};
