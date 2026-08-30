import type { DataPolicy, DefectEnvelope } from "@equipe-tech/observability/policy";
import {
  BrowserClient,
  defaultStackParser,
  makeFetchTransport,
  type ErrorEvent,
} from "@sentry/browser";
import { Effect, Option, Result, Schema } from "effect";
import { parseSentryDsn } from "../SentryDsn.ts";
import { SentryAdapterError } from "../SentryAdapterError.ts";
import { defectDeduplicator } from "../policy/Deduplication.ts";
import {
  projectDefect,
  type ProjectionIdentity,
  type SentryCaptureOutcome,
  type SentryDefectReport,
} from "../policy/DefectProjection.ts";
import { sentryReportState } from "../policy/ReportState.ts";

export type BrowserSentryDefectCapture = {
  readonly envelope: DefectEnvelope;
};

export type BrowserSentryDefectReporterConfig = {
  readonly dsn?: string;
  readonly disabled?: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly environment: string;
  };
  readonly policy: DataPolicy;
  readonly flushDeadlineMs?: number;
  readonly dedupeWindowMs?: number;
  readonly dedupeCapacity?: number;
};

export type BrowserSentryVerificationReceipt = {
  readonly eventId: string;
  readonly flushed: true;
};

export type BrowserSentryDefectReporter = {
  readonly capture: (input: BrowserSentryDefectCapture) => SentryCaptureOutcome;
  readonly flush: () => Promise<boolean>;
  readonly dispose: () => Promise<boolean>;
  readonly sendVerificationDefect: (
    input: BrowserSentryDefectCapture,
  ) => Promise<BrowserSentryVerificationReceipt | SentryCaptureOutcome>;
  readonly reports: () => SentryDefectReport;
};

const PositiveInteger = Schema.Int.check(Schema.makeFilter((value) => value > 0));
const Deadline = PositiveInteger.check(Schema.makeFilter((value) => value <= 5_000));
const ConfigDocument = Schema.Struct({
  dsn: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  service: Schema.Struct({
    name: Schema.NonEmptyString,
    version: Schema.NonEmptyString,
    environment: Schema.NonEmptyString,
  }),
  policy: Schema.Any,
  flushDeadlineMs: Schema.optional(Deadline),
  dedupeWindowMs: Schema.optional(PositiveInteger),
  dedupeCapacity: Schema.optional(PositiveInteger),
});
const decodeConfig = Schema.decodeUnknownOption(ConfigDocument);
const decodeDsn = Schema.decodeUnknownOption(Schema.URLFromString);

const invalidConfig = (): never => {
  throw new SentryAdapterError({
    code: "OBS_SENTRY_CONFIG_INVALID",
    message:
      "The browser Sentry reporter configuration is invalid. Set canonical service identity and positive bounded timing values.",
    cause: "invalid browser Sentry configuration",
  });
};

const randomEventId = (): string => crypto.randomUUID().replaceAll("-", "");

export const createBrowserSentryDefectReporter = (
  config: BrowserSentryDefectReporterConfig,
): BrowserSentryDefectReporter => {
  if (Option.isNone(decodeConfig(config))) return invalidConfig();
  const reportState = sentryReportState();
  const deadline = config.flushDeadlineMs ?? 2_000;
  const identity: ProjectionIdentity = {
    serviceName: config.service.name,
    serviceVersion: config.service.version,
    environment: config.service.environment,
  };
  const dedupe = defectDeduplicator(config.dedupeWindowMs ?? 60_000, config.dedupeCapacity ?? 256);
  let closed = false;
  let flushInFlight: Promise<boolean> | undefined;
  let disposeInFlight: Promise<boolean> | undefined;
  const admitted = new Map<string, BrowserSentryDefectCapture>();
  const decodedDsn = config.dsn === undefined ? Option.none<URL>() : decodeDsn(config.dsn);
  if (config.disabled !== true && config.dsn !== undefined && Option.isNone(decodedDsn)) {
    throw new SentryAdapterError({
      code: "OBS_SENTRY_DSN_INVALID",
      message:
        "The browser Sentry DSN is invalid. Use an HTTP or HTTPS Sentry DSN with a public key and numeric project ID.",
      cause: "invalid browser Sentry DSN",
    });
  }
  if (Option.isSome(decodedDsn)) {
    const validation = Effect.runSync(Effect.result(parseSentryDsn(decodedDsn.value)));
    if (Result.isFailure(validation)) throw validation.failure;
  }
  const enabled = config.disabled !== true && Option.isSome(decodedDsn);
  const client = enabled
    ? new BrowserClient({
        dsn: decodedDsn.value.href,
        release: identity.serviceVersion,
        environment: identity.environment,
        transport: makeFetchTransport,
        stackParser: defaultStackParser,
        integrations: [],
        sendDefaultPii: false,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: { request: false, response: false },
          httpBodies: [],
          queryParams: false,
          urlQueryParams: false,
          graphQL: { document: false, variables: false },
          genAI: { inputs: false, outputs: false },
          databaseQueryData: false,
          stackFrameVariables: false,
          frameContextLines: 0,
        },
        sendClientReports: false,
        maxBreadcrumbs: 0,
        attachStacktrace: false,
        beforeSend: (event): ErrorEvent | null => {
          const id = event.event_id;
          if (id === undefined) return null;
          const accepted = admitted.get(id);
          admitted.delete(id);
          if (accepted === undefined) return null;
          return Option.getOrNull(projectDefect(config.policy, identity, accepted.envelope, id));
        },
        beforeSendTransaction: () => null,
        beforeBreadcrumb: () => null,
      })
    : undefined;

  const capture = (input: BrowserSentryDefectCapture): SentryCaptureOutcome => {
    if (closed) {
      reportState.increment("closed");
      return { kind: "suppressed", reason: "closed" };
    }
    if (client === undefined) {
      reportState.increment("disabled");
      return { kind: "suppressed", reason: "disabled" };
    }
    const decision = dedupe.admit(input.envelope, Date.now());
    if (decision.kind === "deduplicated") {
      reportState.increment(decision.reason);
      return decision;
    }
    const id = randomEventId();
    const projected = projectDefect(config.policy, identity, input.envelope, id);
    if (Option.isNone(projected)) {
      dedupe.rollback(input.envelope, decision.fingerprint);
      reportState.increment("policy");
      return { kind: "suppressed", reason: "policy" };
    }
    admitted.set(id, input);
    const capturedId = client.captureEvent(projected.value);
    reportState.increment("captured");
    return { kind: "captured", eventId: capturedId };
  };

  const flush = async (): Promise<boolean> => {
    if (client === undefined) return true;
    flushInFlight ??= Promise.resolve(client.flush(deadline));
    const completed = await flushInFlight;
    flushInFlight = undefined;
    if (!completed) reportState.increment("flushIncomplete");
    return completed;
  };

  const dispose = async (): Promise<boolean> => {
    if (client === undefined) {
      closed = true;
      return true;
    }
    disposeInFlight ??= Promise.resolve(client.close(deadline));
    const completed = await disposeInFlight;
    if (completed) closed = true;
    return completed;
  };

  const sendVerificationDefect = async (
    input: BrowserSentryDefectCapture,
  ): Promise<BrowserSentryVerificationReceipt | SentryCaptureOutcome> => {
    const outcome = capture(input);
    if (outcome.kind !== "captured") return outcome;
    if (!(await flush())) return { kind: "failed", reason: "transport" };
    return { eventId: outcome.eventId, flushed: true };
  };

  return {
    capture,
    flush,
    dispose,
    sendVerificationDefect,
    reports: reportState.report,
  };
};
