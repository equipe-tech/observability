import { parseDataPolicy, type DataPolicyInput } from "@equipe-tech/observability/policy";
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
import { eventSettlements } from "../policy/EventSettlement.ts";
import {
  projectDefect,
  type ProjectionIdentity,
  type SentryCaptureOutcome,
  type SentryDefectCapture,
  type SentryDefectReport,
  type SentryVerificationReceipt,
} from "../policy/DefectProjection.ts";
import { sentryReportState } from "../policy/ReportState.ts";

export type BrowserSentryDefectReporterConfig = {
  readonly dsn?: string;
  readonly disabled?: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly environment: string;
  };
  readonly policy: DataPolicyInput;
  readonly flushDeadlineMillis?: number;
  readonly closeDeadlineMillis?: number;
  readonly dedupeWindowMillis?: number;
  readonly dedupeCapacity?: number;
};

export type BrowserSentryDefectReporter = {
  readonly capture: (input: SentryDefectCapture) => SentryCaptureOutcome;
  readonly flush: () => Promise<boolean>;
  readonly dispose: () => Promise<boolean>;
  readonly sendVerificationDefect: (
    input: SentryDefectCapture,
  ) => Promise<SentryVerificationReceipt | SentryCaptureOutcome>;
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
  flushDeadlineMillis: Schema.optional(Deadline),
  closeDeadlineMillis: Schema.optional(Deadline),
  dedupeWindowMillis: Schema.optional(PositiveInteger),
  dedupeCapacity: Schema.optional(PositiveInteger),
});
const decodeConfig = Schema.decodeUnknownOption(ConfigDocument);
const decodeDsn = Schema.decodeUnknownOption(Schema.URLFromString);
const configNames = new Set([
  "dsn",
  "disabled",
  "service",
  "policy",
  "flushDeadlineMillis",
  "closeDeadlineMillis",
  "dedupeWindowMillis",
  "dedupeCapacity",
]);
const serviceNames = new Set(["name", "version", "environment"]);

const invalidConfig = (cause: unknown): never => {
  throw new SentryAdapterError({
    code: "OBS_SENTRY_CONFIG_INVALID",
    message:
      "The browser Sentry reporter configuration is invalid. Set canonical service identity, a compilable data policy, and positive bounded timing values.",
    cause,
  });
};

const randomEventId = (): string => crypto.randomUUID().replaceAll("-", "");
const acceptedStatus = (statusCode: number | undefined): boolean =>
  statusCode !== undefined && statusCode >= 200 && statusCode < 300;
const decodeEventId = Schema.decodeUnknownOption(Schema.String);

type CaptureResult = {
  readonly outcome: SentryCaptureOutcome;
  readonly completion?: Promise<boolean>;
};

export const createBrowserSentryDefectReporter = (
  config: BrowserSentryDefectReporterConfig,
): BrowserSentryDefectReporter => {
  if (
    Option.isNone(decodeConfig(config)) ||
    Object.keys(config).some((name) => !configNames.has(name)) ||
    Object.keys(config.service).some((name) => !serviceNames.has(name))
  ) {
    return invalidConfig("invalid browser Sentry configuration");
  }
  const policyResult = Effect.runSync(Effect.result(parseDataPolicy(config.policy)));
  if (Result.isFailure(policyResult)) return invalidConfig(policyResult.failure);
  const policy = policyResult.success;
  const reportState = sentryReportState();
  const flushDeadline = config.flushDeadlineMillis ?? 2_000;
  const closeDeadline = config.closeDeadlineMillis ?? 2_000;
  const identity: ProjectionIdentity = {
    serviceName: config.service.name,
    serviceVersion: config.service.version,
    environment: config.service.environment,
  };
  const dedupe = defectDeduplicator(
    config.dedupeWindowMillis ?? 60_000,
    config.dedupeCapacity ?? 256,
  );
  const settlements = eventSettlements(config.dedupeCapacity ?? 256, dedupe);
  let closed = false;
  let flushInFlight: Promise<boolean> | undefined;
  let disposeInFlight: Promise<boolean> | undefined;
  let disposeResult: boolean | undefined;
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
  let client = enabled
    ? new BrowserClient({
        dsn: decodedDsn.value.href,
        release: identity.serviceVersion,
        environment: identity.environment,
        transport: (transportOptions) => {
          const transport = makeFetchTransport(transportOptions);
          return {
            flush: (timeout) => transport.flush(timeout),
            send: (envelope) => {
              const id = decodeEventId(envelope[0].event_id);
              return Promise.resolve(transport.send(envelope)).then(
                (response) => {
                  if (Option.isSome(id))
                    settlements.settle(id.value, acceptedStatus(response.statusCode));
                  return response;
                },
                (cause) => {
                  if (Option.isSome(id)) settlements.reject(id.value);
                  throw cause;
                },
              );
            },
          };
        },
        stackParser: defaultStackParser,
        integrations: [],
        sendDefaultPii: false,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: { request: false, response: false },
          httpBodies: [],
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
          const accepted = settlements.input(id);
          if (accepted === undefined) return null;
          const projected = projectDefect(policy, identity, accepted.envelope, id);
          if (Option.isNone(projected)) settlements.reject(id);
          return Option.getOrNull(projected);
        },
        beforeSendTransaction: () => null,
        beforeBreadcrumb: () => null,
      })
    : undefined;

  const captureNow = (input: SentryDefectCapture): CaptureResult => {
    if (closed) {
      reportState.increment("closed");
      return { outcome: { kind: "suppressed", reason: "closed" } };
    }
    const current = client;
    if (current === undefined) {
      reportState.increment("disabled");
      return { outcome: { kind: "suppressed", reason: "disabled" } };
    }
    const id = randomEventId();
    const decision = dedupe.admit(id, input.envelope, Date.now());
    if (decision.kind === "deduplicated") {
      reportState.increment(decision.reason);
      return { outcome: decision };
    }
    const projected = projectDefect(policy, identity, input.envelope, id);
    if (Option.isNone(projected)) {
      dedupe.rollback(id);
      reportState.increment("policy");
      return { outcome: { kind: "suppressed", reason: "policy" } };
    }
    const completion = settlements.reserve(id, input);
    if (completion === undefined) {
      dedupe.rollback(id);
      reportState.increment("transport");
      return { outcome: { kind: "failed", reason: "transport" } };
    }
    try {
      current.captureEvent(projected.value);
    } catch {
      settlements.reject(id);
      reportState.increment("transport");
      return { outcome: { kind: "failed", reason: "transport" } };
    }
    reportState.increment("captured");
    return { outcome: { kind: "captured", eventId: id }, completion };
  };

  const capture = (input: SentryDefectCapture): SentryCaptureOutcome => captureNow(input).outcome;

  const flush = async (): Promise<boolean> => {
    const current = client;
    if (current === undefined) return true;
    if (flushInFlight === undefined) {
      flushInFlight = Promise.resolve(current.flush(flushDeadline))
        .catch(() => false)
        .then((completed) => {
          if (!completed) reportState.increment("flushIncomplete");
          return completed;
        })
        .finally(() => {
          flushInFlight = undefined;
        });
    }
    return flushInFlight;
  };

  const dispose = async (): Promise<boolean> => {
    if (closed) return disposeResult ?? true;
    const current = client;
    if (current === undefined) {
      closed = true;
      disposeResult = true;
      return true;
    }
    if (disposeInFlight === undefined) {
      disposeInFlight = Promise.resolve(current.close(closeDeadline))
        .catch(() => false)
        .then((completed) => {
          settlements.clear();
          client = undefined;
          closed = true;
          disposeResult = completed;
          return completed;
        });
    }
    return disposeInFlight;
  };

  const sendVerificationDefect = async (
    input: SentryDefectCapture,
  ): Promise<SentryVerificationReceipt | SentryCaptureOutcome> => {
    const result = captureNow(input);
    if (result.outcome.kind !== "captured" || result.completion === undefined)
      return result.outcome;
    const completed = await flush();
    if (!completed) settlements.reject(result.outcome.eventId);
    const accepted = await result.completion;
    if (!completed || !accepted) {
      reportState.increment("transport");
      return { kind: "failed", reason: "transport" };
    }
    return { eventId: result.outcome.eventId, flushed: true };
  };

  return {
    capture,
    flush,
    dispose,
    sendVerificationDefect,
    reports: reportState.report,
  };
};
