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
import { randomUUID } from "node:crypto";
import { parseSentryDsn } from "../SentryDsn.ts";
import { SentryAdapterError } from "../SentryAdapterError.ts";
import { defectDeduplicator } from "../policy/Deduplication.ts";
import {
  projectDefect,
  type ProjectionIdentity,
  type SentryCaptureOutcome,
  type SentryDefectCapture,
  type SentryDefectReport,
} from "../policy/DefectProjection.ts";
import { sentryReportState } from "../policy/ReportState.ts";

export type SentryDefectAdapterOptions = {
  readonly flushDeadlineMillis?: number;
  readonly closeDeadlineMillis?: number;
  readonly dedupeWindowMillis?: number;
  readonly dedupeCapacity?: number;
};

export type SentryVerificationReceipt = {
  readonly eventId: string;
  readonly flushed: true;
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
  dedupeWindowMillis: Schema.optional(PositiveInteger),
  dedupeCapacity: Schema.optional(PositiveInteger),
});
const decodeOptions = Schema.decodeUnknownOption(OptionsDocument);
const optionNames = new Set([
  "flushDeadlineMillis",
  "closeDeadlineMillis",
  "dedupeWindowMillis",
  "dedupeCapacity",
]);

type ResolvedOptions = {
  readonly flushDeadlineMillis: number;
  readonly closeDeadlineMillis: number;
  readonly dedupeWindowMillis: number;
  readonly dedupeCapacity: number;
};

type ActiveClient = {
  readonly client: LightNodeClient;
  readonly context: ObservabilityAdapterContext;
  readonly identity: ProjectionIdentity;
};

const resolveOptions = (
  options: SentryDefectAdapterOptions,
): Effect.Effect<ResolvedOptions, SentryAdapterError> => {
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

const eventId = (): string => randomUUID().replaceAll("-", "");

export const sentryDefectAdapter = (
  options: SentryDefectAdapterOptions = {},
): SentryDefectAdapter => {
  const reportState = sentryReportState();
  let active: ActiveClient | undefined;
  let closed = false;
  let flushInFlight: Promise<boolean> | undefined;
  let closeInFlight: Promise<boolean> | undefined;
  const admitted = new Map<string, SentryDefectCapture>();
  const lifecycleOptions = {
    flushDeadlineMillis: options.flushDeadlineMillis ?? 2_000,
    closeDeadlineMillis: options.closeDeadlineMillis ?? 2_000,
    dedupeWindowMillis: options.dedupeWindowMillis ?? 60_000,
    dedupeCapacity: options.dedupeCapacity ?? 256,
  };
  const dedupe = defectDeduplicator(
    lifecycleOptions.dedupeWindowMillis,
    lifecycleOptions.dedupeCapacity,
  );

  const captureNow = (input: SentryDefectCapture): SentryCaptureOutcome => {
    if (closed) {
      reportState.increment("closed");
      return { kind: "suppressed", reason: "closed" };
    }
    if (active === undefined) {
      reportState.increment("disabled");
      return { kind: "suppressed", reason: "disabled" };
    }
    const decision = dedupe.admit(input.envelope, Date.now());
    if (decision.kind === "deduplicated") {
      reportState.increment(decision.reason);
      return decision;
    }
    const id = eventId();
    const projected = projectDefect(active.context.policy, active.identity, input.envelope, id);
    if (Option.isNone(projected)) {
      dedupe.rollback(input.envelope, decision.fingerprint);
      reportState.increment("policy");
      return { kind: "suppressed", reason: "policy" };
    }
    admitted.set(id, input);
    const capturedId = active.client.captureEvent(projected.value);
    reportState.increment("captured");
    return { kind: "captured", eventId: capturedId };
  };

  const flush = async (): Promise<boolean> => {
    if (active === undefined) return true;
    flushInFlight ??= Promise.resolve(active.client.flush(lifecycleOptions.flushDeadlineMillis));
    const completed = await flushInFlight;
    flushInFlight = undefined;
    if (!completed) reportState.increment("flushIncomplete");
    return completed;
  };

  const close = async (): Promise<boolean> => {
    if (active === undefined) return true;
    closeInFlight ??= Promise.resolve(active.client.close(lifecycleOptions.closeDeadlineMillis));
    const completed = await closeInFlight;
    if (completed) {
      active = undefined;
      closed = true;
    }
    return completed;
  };

  const registration = registerOfficialAdapter({
    name: AdapterName.make("sentry-defects"),
    capability: "defects",
    stage: "server",
    start: (context) =>
      Effect.gen(function* () {
        yield* resolveOptions(options).pipe(Effect.mapError(adapterFailure));
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
        const client = new LightNodeClient({
          dsn: parsed.dsn.href,
          release: identity.serviceVersion,
          environment: identity.environment,
          transport: makeNodeTransport,
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
            return Option.getOrNull(projectDefect(context.policy, identity, accepted.envelope, id));
          },
          beforeSendTransaction: () => null,
          beforeBreadcrumb: () => null,
        });
        active = { client, context, identity };
        closed = false;
        return {
          flush: Effect.promise(flush).pipe(Effect.asVoid),
          close: Effect.promise(close).pipe(Effect.asVoid),
          eventLayer: Option.none(),
          degraded: () => reportState.report().reasons.flushIncomplete > 0,
        };
      }),
  });

  const capture = (input: SentryDefectCapture): Effect.Effect<SentryCaptureOutcome> =>
    Effect.sync(() => captureNow(input));
  const captureAsync = (input: SentryDefectCapture): Promise<SentryCaptureOutcome> =>
    Promise.resolve(captureNow(input));
  const sendVerificationDefect = async (
    input: SentryDefectCapture,
  ): Promise<SentryVerificationReceipt | SentryCaptureOutcome> => {
    const outcome = captureNow(input);
    if (outcome.kind !== "captured") return outcome;
    if (!(await flush())) return { kind: "failed", reason: "transport" };
    return { eventId: outcome.eventId, flushed: true };
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
