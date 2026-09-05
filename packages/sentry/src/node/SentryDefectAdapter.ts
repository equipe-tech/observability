import {
  AdapterFailure,
  AdapterName,
  registerOfficialAdapter,
  type OfficialAdapterRegistration,
  type ObservabilityAdapterContext,
} from "@equipe-tech/observability";
import { defaultStackParser, LightNodeClient, makeNodeTransport } from "@sentry/node-core/light";
import type { ErrorEvent } from "@sentry/node-core/light";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { parseSentryDsn } from "../SentryDsn.ts";
import { SentryAdapterError } from "../SentryAdapterError.ts";
import { captureDefectNow, type CaptureResult } from "../policy/CaptureOwner.ts";
import { defectDeduplicator, type DefectDeduplicator } from "../policy/Deduplication.ts";
import { eventSettlements, type EventSettlements } from "../policy/EventSettlement.ts";
import { secureEventId } from "../policy/EventId.ts";
import {
  projectFinalEvent,
  type ProjectedSentryEvent,
  type ProjectionIdentity,
  type SentryCaptureOutcome,
  type SentryDefectCapture,
  type SentryDefectReport,
  type SentryVerificationReceipt,
} from "../policy/DefectProjection.ts";
import { sentryReportState } from "../policy/ReportState.ts";

export type SentryDefectAdapterOptions = {
  readonly flushDeadlineMillis?: number;
  readonly closeDeadlineMillis?: number;
  readonly terminalSettlementDeadlineMillis?: number;
  readonly dedupeWindowMillis?: number;
  readonly dedupeCapacity?: number;
};

export type SentryDefectAdapter = {
  readonly registration: OfficialAdapterRegistration;
  readonly layer: Layer.Layer<SentryDefects>;
  readonly capture: (input: SentryDefectCapture) => Effect.Effect<SentryCaptureOutcome>;
  readonly captureAsync: (input: SentryDefectCapture) => Promise<SentryCaptureOutcome>;
  readonly sendVerificationDefect: (
    input: SentryDefectCapture,
  ) => Promise<SentryVerificationReceipt | SentryCaptureOutcome>;
  readonly reports: () => SentryDefectReport;
};

export class SentryDefects extends Context.Service<
  SentryDefects,
  {
    readonly capture: (input: SentryDefectCapture) => Effect.Effect<SentryCaptureOutcome>;
  }
>()("@equipe-tech/observability-sentry/SentryDefects") {}

const PositiveInteger = Schema.Int.check(Schema.makeFilter((value) => value > 0));
const Deadline = PositiveInteger.check(Schema.makeFilter((value) => value <= 5_000));
const OptionsDocument = Schema.Struct({
  flushDeadlineMillis: Schema.optional(Deadline),
  closeDeadlineMillis: Schema.optional(Deadline),
  terminalSettlementDeadlineMillis: Schema.optional(Deadline),
  dedupeWindowMillis: Schema.optional(PositiveInteger),
  dedupeCapacity: Schema.optional(PositiveInteger),
});
const decodeOptions = Schema.decodeUnknownOption(OptionsDocument);
const optionNames = new Set([
  "flushDeadlineMillis",
  "closeDeadlineMillis",
  "terminalSettlementDeadlineMillis",
  "dedupeWindowMillis",
  "dedupeCapacity",
]);

type AdapterOptions = {
  readonly flushDeadlineMillis: number;
  readonly closeDeadlineMillis: number;
  readonly terminalSettlementDeadlineMillis: number;
  readonly dedupeWindowMillis: number;
  readonly dedupeCapacity: number;
};

type ActiveClient = {
  readonly client: LightNodeClient;
  readonly context: ObservabilityAdapterContext;
  readonly identity: ProjectionIdentity;
  readonly dedupe: DefectDeduplicator;
  readonly settlements: EventSettlements<ProjectedSentryEvent>;
  readonly options: AdapterOptions;
};

const resolveOptions = (
  options: SentryDefectAdapterOptions,
): Effect.Effect<AdapterOptions, SentryAdapterError> => {
  if (
    Option.isNone(decodeOptions(options)) ||
    Object.keys(options).some((name) => !optionNames.has(name))
  ) {
    return Effect.fail(
      new SentryAdapterError({
        code: "OBS_SENTRY_CONFIG_INVALID",
        message:
          "The Sentry adapter configuration is invalid. Use documented positive limits and deadlines no greater than 5000 milliseconds.",
        cause: "invalid Sentry adapter options",
      }),
    );
  }
  return Effect.succeed({
    flushDeadlineMillis: options.flushDeadlineMillis ?? 2_000,
    closeDeadlineMillis: options.closeDeadlineMillis ?? 2_000,
    terminalSettlementDeadlineMillis:
      options.terminalSettlementDeadlineMillis ?? terminalSettlementDeadlineMillis,
    dedupeWindowMillis: options.dedupeWindowMillis ?? 60_000,
    dedupeCapacity: options.dedupeCapacity ?? 256,
  });
};

const adapterFailure = (cause: SentryAdapterError): AdapterFailure =>
  new AdapterFailure({
    code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
    message: cause.message,
    cause,
  });

const terminalSettlementDeadlineMillis = 5_000;
const acceptedStatus = (statusCode: number | undefined): boolean =>
  statusCode !== undefined && statusCode >= 200 && statusCode < 300;
const decodeEventId = Schema.decodeUnknownOption(Schema.String);
const decodeSentAt = Schema.decodeUnknownOption(Schema.String);

export const sentryDefectAdapter = (
  options: SentryDefectAdapterOptions = {},
): SentryDefectAdapter => {
  const reportState = sentryReportState();
  let active: ActiveClient | undefined;
  let startReservation: symbol | undefined;
  let closed = false;
  let flushInFlight: Promise<boolean> | undefined;
  let closeInFlight: Promise<boolean> | undefined;
  let closeResult: boolean | undefined;
  let verificationTail: Promise<void> = Promise.resolve();

  const reserveStart = (reservation: symbol) =>
    Effect.sync(() => {
      if (startReservation !== undefined || active !== undefined) return false;
      startReservation = reservation;
      return true;
    });

  const captureNow = (input: SentryDefectCapture): CaptureResult => {
    const current = active;
    const runtime =
      current === undefined
        ? undefined
        : {
            policy: current.context.policy,
            identity: current.identity,
            dedupe: current.dedupe,
            settlements: current.settlements,
            stackParser: defaultStackParser,
            send: (event: ProjectedSentryEvent) =>
              current.client.captureEvent(projectFinalEvent(event)),
          };
    return captureDefectNow(input, closed, runtime, secureEventId, reportState);
  };

  const flush = async (): Promise<boolean> => {
    const current = active;
    if (current === undefined) return true;
    if (flushInFlight === undefined) {
      const operation = Promise.resolve(current.client.flush(current.options.flushDeadlineMillis))
        .catch(() => false)
        .then((completed) => {
          if (!completed) reportState.increment("flushIncomplete");
          return completed;
        });
      flushInFlight = operation.finally(() => {
        flushInFlight = undefined;
      });
    }
    return flushInFlight;
  };

  const close = (): Promise<boolean> => {
    if (closeInFlight !== undefined) return closeInFlight;
    if (closed) return Promise.resolve(closeResult ?? true);
    const current = active;
    if (current === undefined) {
      closed = true;
      closeResult = true;
      closeInFlight = Promise.resolve(true);
      return closeInFlight;
    }
    closed = true;
    closeInFlight = Promise.resolve(current.client.close(current.options.closeDeadlineMillis))
      .catch(() => false)
      .then((completed) => {
        current.settlements.clear();
        if (!completed) reportState.increment("flushIncomplete");
        active = undefined;
        closed = true;
        closeResult = completed;
        return completed;
      });
    return closeInFlight;
  };

  const registration = registerOfficialAdapter({
    name: AdapterName.make("sentry-defects"),
    capability: "defects",
    stage: "server",
    start: (context) => {
      const reservation = Symbol();
      return Effect.gen(function* () {
        if (!(yield* reserveStart(reservation))) {
          return yield* adapterFailure(
            new SentryAdapterError({
              code: "OBS_SENTRY_CONFIG_INVALID",
              message:
                "The Sentry adapter instance is already started. Close its runtime before starting another.",
              cause: "Sentry adapter instance already started",
            }),
          );
        }
        const resolved = yield* resolveOptions(options).pipe(Effect.mapError(adapterFailure));
        if (!context.sentry.enabled) {
          return yield* adapterFailure(
            new SentryAdapterError({
              code: "OBS_SENTRY_DISABLED",
              message: `Profile "${context.profile.name}" registered Sentry without a DSN. Set SENTRY_DSN or remove the adapter.`,
              cause: "Sentry is disabled",
            }),
          );
        }
        const parsed = yield* parseSentryDsn(context.sentry.dsn).pipe(
          Effect.mapError(adapterFailure),
        );
        const identity = {
          serviceName: context.identity.serviceName,
          serviceVersion: context.identity.serviceVersion,
          environment: context.identity.environment,
        };
        const dedupe = defectDeduplicator(resolved.dedupeWindowMillis, resolved.dedupeCapacity);
        const settlements = eventSettlements<ProjectedSentryEvent>(
          resolved.dedupeCapacity,
          resolved.terminalSettlementDeadlineMillis,
          dedupe,
        );
        const client = new LightNodeClient({
          dsn: parsed.dsn.href,
          release: identity.serviceVersion,
          environment: identity.environment,
          transport: (transportOptions) => {
            const transport = makeNodeTransport(transportOptions);
            return {
              flush: (timeout) => transport.flush(timeout),
              send: (envelope) => {
                const id = decodeEventId(envelope[0].event_id);
                if (Option.isNone(id)) return Promise.resolve({ statusCode: 400 });
                const accepted = settlements.input(id.value);
                const item = envelope[1][0];
                if (accepted === undefined || item === undefined) {
                  return Promise.resolve({ statusCode: 400 });
                }
                const sentAt = decodeSentAt(envelope[0].sent_at);
                envelope[0] = Option.isSome(sentAt)
                  ? { event_id: id.value, sent_at: sentAt.value }
                  : { event_id: id.value };
                envelope[1].length = 0;
                envelope[1][0] = [{ type: "event" }, projectFinalEvent(accepted)];
                return Promise.resolve(transport.send(envelope)).then(
                  (response) => {
                    settlements.settle(id.value, acceptedStatus(response.statusCode));
                    return response;
                  },
                  (cause) => {
                    settlements.reject(id.value);
                    throw cause;
                  },
                );
              },
            };
          },
          stackParser: defaultStackParser,
          integrations: [],
          includeServerName: false,
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
            return projectFinalEvent(accepted);
          },
          beforeSendTransaction: () => null,
          beforeBreadcrumb: () => null,
        });
        active = { client, context, identity, dedupe, settlements, options: resolved };
        closed = false;
        closeResult = undefined;
        closeInFlight = undefined;
        return {
          flush: Effect.promise(flush).pipe(Effect.asVoid),
          close: Effect.promise(close).pipe(Effect.asVoid),
          eventLayer: Option.none(),
          auditLayer: Option.none(),
          degraded: () => {
            const reasons = reportState.report().reasons;
            return reasons.transport > 0 || reasons.flushIncomplete > 0;
          },
        };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (startReservation === reservation) startReservation = undefined;
          }),
        ),
      );
    },
  });

  const capture = (input: SentryDefectCapture): Effect.Effect<SentryCaptureOutcome> =>
    Effect.sync(() => captureNow(input).outcome);
  const captureAsync = (input: SentryDefectCapture): Promise<SentryCaptureOutcome> =>
    Promise.resolve(captureNow(input).outcome);
  const sendVerificationDefect = (
    input: SentryDefectCapture,
  ): Promise<SentryVerificationReceipt | SentryCaptureOutcome> => {
    const operation = verificationTail.then(
      async (): Promise<SentryVerificationReceipt | SentryCaptureOutcome> => {
        const result = captureNow(input);
        if (result.outcome.kind !== "queued" || result.completion === undefined) {
          return result.outcome;
        }
        const completed = await flush();
        if (!completed) return { kind: "failed", reason: "transport" };
        if (active?.settlements.pending(result.outcome.eventId) === true) {
          active.settlements.reject(result.outcome.eventId);
        }
        const accepted = await result.completion;
        if (!accepted) return { kind: "failed", reason: "transport" };
        return { eventId: result.outcome.eventId, flushed: true };
      },
    );
    verificationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  return {
    registration,
    layer: Layer.succeed(SentryDefects, { capture }),
    capture,
    captureAsync,
    sendVerificationDefect,
    reports: reportState.report,
  };
};
