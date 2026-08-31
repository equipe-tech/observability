import {
  AdapterFailure,
  AuditPublisher,
  type AuditPublishReport,
  type AuditPublishReceipt,
  type CommittedAuditRecord,
  AdapterName,
  BrowserEvents,
  Contract,
  instanceResourceAttributes,
  registerOfficialAdapter,
  SpanId,
  TelemetryEventSink,
  TraceId,
  transformSignalFields,
  validateContractEvent,
  type BrowserTelemetryEvent,
  type DataPolicy,
  type EventAdmissionMetadata,
  type EventAttributes,
  type OfficialAdapterRegistration,
  type ObservabilityAdapterContext,
  type TelemetryEvent,
} from "@equipe-tech/observability";
import {
  AUDIT_SCHEMA_VERSION,
  auditOnly,
  buildAuditFields,
  createError,
  signed,
  defineErrorCatalog,
  initLogger,
  log,
  type AuditInput,
  type DrainContext,
  type DrainFn,
  type SignedOptions,
  type WideEvent,
} from "evlog";
import { sendBatchToOTLP } from "evlog/otlp";
import { createDrainPipeline, type PipelineDrainFn } from "evlog/pipeline";
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect";
import { EvlogAdapterError } from "./EvlogAdapterError.ts";

export type EvlogDropReasonCounts = {
  readonly countOverflow: number;
  readonly byteOverflow: number;
  readonly transport: number;
  readonly stdoutUnavailable: number;
  readonly contractRejected: number;
  readonly closed: number;
};

export type EvlogDropReport = {
  readonly total: number;
  readonly firstDroppedAt: Option.Option<string>;
  readonly lastDroppedAt: Option.Option<string>;
  readonly reasons: EvlogDropReasonCounts;
};

type EvlogPending = {
  readonly count: number;
  readonly serializedBytes: number;
};

type EvlogOutput = {
  readonly write: (line: string) => boolean;
};

export type EvlogAuditIntegrityOptions = SignedOptions;

export type EvlogAdapterOptions = {
  readonly maximumBufferedEvents?: number;
  readonly maximumBufferedBytes?: number;
  readonly batchSize?: number;
  readonly batchIntervalMillis?: number;
  readonly maximumAttempts?: number;
  readonly initialRetryDelayMillis?: number;
  readonly maximumRetryDelayMillis?: number;
  readonly transportTimeoutMillis?: number;
  readonly transportRetries?: number;
  readonly installGlobalLogger?: boolean;
  readonly auditDedupeWindowMillis?: number;
  readonly auditDedupeCapacity?: number;
  readonly auditIntegrity?: EvlogAuditIntegrityOptions;
  readonly requestEventName?: string;
  readonly stdout?: EvlogOutput;
};

export type EvlogAdapter = {
  readonly registration: OfficialAdapterRegistration;
  readonly drops: () => EvlogDropReport;
  readonly pending: () => EvlogPending;
};

type ResolvedOptions = {
  readonly maximumBufferedEvents: number;
  readonly maximumBufferedBytes: number;
  readonly batchSize: number;
  readonly batchIntervalMillis: number;
  readonly maximumAttempts: number;
  readonly initialRetryDelayMillis: number;
  readonly maximumRetryDelayMillis: number;
  readonly transportTimeoutMillis: number;
  readonly transportRetries: number;
  readonly installGlobalLogger: boolean;
  readonly auditDedupeWindowMillis: number;
  readonly auditDedupeCapacity: number;
  readonly auditIntegrity: Option.Option<EvlogAuditIntegrityOptions>;
  readonly requestEventName: Option.Option<string>;
  readonly stdout: EvlogOutput;
};

type AuditReservationTerminal = "delivered" | "retry";

type OfferResult =
  | { readonly kind: "queued" }
  | {
      readonly kind: "closed" | "queue-overflow";
      readonly droppedAt: string;
    };

type AuditReservation = {
  readonly terminal: Promise<AuditReservationTerminal>;
  readonly resolve: (terminal: AuditReservationTerminal) => void;
};

type AdmittedRecord = {
  readonly event: WideEvent;
  readonly serialized: string;
  readonly serializedBytes: number;
  readonly auditRecordId?: string;
  readonly auditReservation?: AuditReservation;
};

type MutableDropState = {
  total: number;
  firstDroppedAt: Option.Option<string>;
  lastDroppedAt: Option.Option<string>;
  countOverflow: number;
  byteOverflow: number;
  transport: number;
  stdoutUnavailable: number;
  contractRejected: number;
  closed: number;
};

const adapterErrors = defineErrorCatalog("OBS_EVLOG", {
  TRANSPORT_FAILED: {
    status: 503,
    message: "The evlog OTLP batch could not be delivered within its bounded attempts.",
  },
  LOGGER_CONFLICT: {
    status: 500,
    message: "Another observability evlog adapter owns the process-global logger.",
  },
});

const positiveInteger = Schema.Int.check(Schema.makeFilter((value) => value > 0));
const nonNegativeInteger = Schema.Int.check(Schema.makeFilter((value) => value >= 0));
const AuditIntegrityDocument = Schema.Union([
  Schema.Struct({
    strategy: Schema.Literal("hmac"),
    secret: Schema.NonEmptyString,
    algorithm: Schema.Literals(["sha256", "sha512"]).pipe(Schema.optionalKey),
  }),
  Schema.Struct({
    strategy: Schema.Literal("hash-chain"),
    state: Schema.Struct({
      load: Schema.instanceOf(Function),
      save: Schema.instanceOf(Function),
    }).pipe(Schema.optionalKey),
    algorithm: Schema.Literals(["sha256", "sha512"]).pipe(Schema.optionalKey),
  }),
]);
const AdapterOptionsDocument = Schema.Struct({
  maximumBufferedEvents: Schema.optional(positiveInteger),
  maximumBufferedBytes: Schema.optional(positiveInteger),
  batchSize: Schema.optional(positiveInteger),
  batchIntervalMillis: Schema.optional(positiveInteger),
  maximumAttempts: Schema.optional(positiveInteger),
  initialRetryDelayMillis: Schema.optional(nonNegativeInteger),
  maximumRetryDelayMillis: Schema.optional(nonNegativeInteger),
  transportTimeoutMillis: Schema.optional(positiveInteger),
  transportRetries: Schema.optional(nonNegativeInteger),
  installGlobalLogger: Schema.optional(Schema.Boolean),
  auditDedupeWindowMillis: Schema.optional(positiveInteger),
  auditDedupeCapacity: Schema.optional(positiveInteger),
  auditIntegrity: Schema.optional(AuditIntegrityDocument),
  requestEventName: Schema.optional(Schema.NonEmptyString),
  stdout: Schema.optional(
    Schema.Struct({
      write: Schema.instanceOf(Function),
    }),
  ),
});
const decodeOptions = Schema.decodeUnknownOption(AdapterOptionsDocument);
const decodeString = Schema.decodeUnknownOption(Schema.String);
const decodeNumber = Schema.decodeUnknownOption(Schema.Number.check(Schema.isFinite()));
const decodeDate = Schema.decodeUnknownOption(Schema.Date);
const decodeScalar = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite()), Schema.Boolean]),
);
const decodeTraceId = Schema.decodeUnknownOption(TraceId);
const decodeSpanId = Schema.decodeUnknownOption(SpanId);
const textEncoder = new TextEncoder();
const globalEnvelopeFields = new Set([
  "timestamp",
  "level",
  "service",
  "environment",
  "version",
  "commitHash",
  "region",
  "duration",
  "durationMs",
  "method",
  "path",
  "status",
  "requestId",
  "audit",
  "event.name",
  "traceId",
  "spanId",
]);
let globalLoggerOwner: symbol | undefined;

const defaultOutput: EvlogOutput = {
  write: (line) => process.stdout.write(line),
};

const optionNames = new Set([
  "maximumBufferedEvents",
  "maximumBufferedBytes",
  "batchSize",
  "batchIntervalMillis",
  "maximumAttempts",
  "initialRetryDelayMillis",
  "maximumRetryDelayMillis",
  "transportTimeoutMillis",
  "transportRetries",
  "installGlobalLogger",
  "auditDedupeWindowMillis",
  "auditDedupeCapacity",
  "auditIntegrity",
  "requestEventName",
  "stdout",
]);

const invalidOptions = (message: string): EvlogAdapterError =>
  new EvlogAdapterError({
    code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
    message,
    cause: "invalid evlog adapter options",
  });

const resolveOptions = (
  options: EvlogAdapterOptions,
): Effect.Effect<ResolvedOptions, EvlogAdapterError> =>
  Effect.gen(function* () {
    if (
      Option.isNone(decodeOptions(options)) ||
      Object.keys(options).some((name) => !optionNames.has(name))
    ) {
      return yield* invalidOptions(
        "The evlog adapter configuration is invalid. Use only documented options with positive queue and timing limits and non-negative retry counts.",
      );
    }
    const resolved = {
      maximumBufferedEvents: options.maximumBufferedEvents ?? 1_000,
      maximumBufferedBytes: options.maximumBufferedBytes ?? 8_388_608,
      batchSize: options.batchSize ?? 50,
      batchIntervalMillis: options.batchIntervalMillis ?? 1_000,
      maximumAttempts: options.maximumAttempts ?? 3,
      initialRetryDelayMillis: options.initialRetryDelayMillis ?? 100,
      maximumRetryDelayMillis: options.maximumRetryDelayMillis ?? 1_000,
      transportTimeoutMillis: options.transportTimeoutMillis ?? 5_000,
      transportRetries: options.transportRetries ?? 2,
      installGlobalLogger: options.installGlobalLogger ?? true,
      auditDedupeWindowMillis: options.auditDedupeWindowMillis ?? 300_000,
      auditDedupeCapacity: options.auditDedupeCapacity ?? 10_000,
      auditIntegrity: Option.fromNullishOr(options.auditIntegrity),
      requestEventName: Option.fromNullishOr(options.requestEventName),
      stdout: options.stdout ?? defaultOutput,
    };
    if (resolved.batchSize > resolved.maximumBufferedEvents) {
      return yield* invalidOptions(
        "The evlog batch size exceeds the event queue limit. Set batchSize at or below maximumBufferedEvents.",
      );
    }
    return resolved;
  });

const emptyDropState = (): MutableDropState => ({
  total: 0,
  firstDroppedAt: Option.none(),
  lastDroppedAt: Option.none(),
  countOverflow: 0,
  byteOverflow: 0,
  transport: 0,
  stdoutUnavailable: 0,
  contractRejected: 0,
  closed: 0,
});

const reportFor = (state: MutableDropState): EvlogDropReport => ({
  total: state.total,
  firstDroppedAt: state.firstDroppedAt,
  lastDroppedAt: state.lastDroppedAt,
  reasons: {
    countOverflow: state.countOverflow,
    byteOverflow: state.byteOverflow,
    transport: state.transport,
    stdoutUnavailable: state.stdoutUnavailable,
    contractRejected: state.contractRejected,
    closed: state.closed,
  },
});

type DropReason =
  | "count-overflow"
  | "byte-overflow"
  | "transport"
  | "stdout-unavailable"
  | "contract-rejected"
  | "closed";

const incrementReason = (state: MutableDropState, reason: DropReason, droppedAt: string): void => {
  switch (reason) {
    case "count-overflow":
      state.countOverflow += 1;
      break;
    case "byte-overflow":
      state.byteOverflow += 1;
      break;
    case "transport":
      state.transport += 1;
      break;
    case "stdout-unavailable":
      state.stdoutUnavailable += 1;
      break;
    case "contract-rejected":
      state.contractRejected += 1;
      break;
    case "closed":
      state.closed += 1;
      break;
  }
  state.total += 1;
  if (Option.isNone(state.firstDroppedAt)) state.firstDroppedAt = Option.some(droppedAt);
  state.lastDroppedAt = Option.some(droppedAt);
};

const normalizeGlobalTimestamp = (
  value: DrainContext["event"]["timestamp"],
): Option.Option<string> => {
  const date = decodeDate(value);
  const string = decodeString(value);
  const number = decodeNumber(value);
  const milliseconds = Option.isSome(date)
    ? date.value.getTime()
    : Option.isSome(string)
      ? Date.parse(string.value)
      : Option.isSome(number)
        ? number.value
        : Number.NaN;
  return Number.isFinite(milliseconds) &&
    milliseconds >= 0 &&
    milliseconds <= BrowserEvents.maxBrowserEventOccurredAt
    ? Option.some(new Date(milliseconds).toISOString())
    : Option.none();
};

const fieldsForContractEvent = (
  event: TelemetryEvent,
  attributes: EventAttributes,
): EventAttributes => {
  const fields: { [attributeName: string]: Contract.AttributeValue } = {
    "event.name": event.name,
    "event.kind": "wide",
    "event.type": event.kind,
    "event.severity": event.severity,
    "event.outcome": event.outcome,
    "event.timestamp": event.timestamp,
  };
  for (const [name, value] of Object.entries(attributes)) fields[name] = value;
  if (Option.isSome(event.correlation.requestId))
    fields["request.id"] = event.correlation.requestId.value;
  if (Option.isSome(event.correlation.runId)) fields["run.id"] = event.correlation.runId.value;
  switch (event.kind) {
    case "request":
      fields["event.duration_ms"] = event.durationMs;
      fields["http.request.method"] = event.http.method;
      fields["http.route"] = event.http.route;
      fields["http.response.status_code"] = event.http.statusCode;
      break;
    case "operation":
      fields["event.duration_ms"] = event.durationMs;
      break;
    case "defect": {
      const structured = createError({
        code: event.error.type,
        message: event.error.message,
        status: event.error.retryable ? 503 : 500,
      });
      fields["error.type"] = structured.code ?? structured.name;
      fields["error.name"] = structured.name;
      fields["error.message"] = structured.message;
      fields["error.status"] = structured.status;
      fields["error.retryable"] = event.error.retryable;
      break;
    }
    case "audit":
      fields["event.outcome"] = event.outcome === "success" ? "success" : "failure";
      fields["audit.outcome"] = event.outcome;
      fields["audit.action"] = event.audit.action;
      fields["audit.actor.kind"] = event.audit.actor.kind;
      fields["audit.actor.id"] =
        event.audit.actor.kind === "system" ? "system" : event.audit.actor.id;
      fields["audit.resource.type"] = event.audit.resourceType;
      fields["audit.resource.id"] = event.audit.resourceId;
      if (event.audit.reasonCode !== undefined)
        fields["audit.reason_code"] = event.audit.reasonCode;
      break;
  }
  return fields;
};

const levelFor = (severity: Contract.EventSeverity): "debug" | "info" | "warn" | "error" =>
  severity === "fatal" ? "error" : severity;

const wideEventFor = (
  context: ObservabilityAdapterContext,
  timestamp: string,
  severity: Contract.EventSeverity,
  fields: EventAttributes,
  traceId?: string,
  spanId?: string,
): WideEvent => {
  const event = {
    timestamp,
    level: levelFor(severity),
    service: context.identity.serviceName,
    environment: context.identity.environment,
    version: context.identity.serviceVersion,
    ...fields,
  };
  if (traceId !== undefined) Object.assign(event, { traceId });
  if (spanId !== undefined) Object.assign(event, { spanId });
  return event;
};

const resourceAttributesFor = (context: ObservabilityAdapterContext) => {
  const supported = instanceResourceAttributes(
    context.identity,
    context.telemetryConfig.environmentAlias,
  );
  return Object.fromEntries(
    Object.entries(supported).filter(
      ([name]) =>
        name !== "service.name" && name !== "service.version" && name !== "deployment.environment",
    ),
  );
};

const finalCanonicalFields = (
  policy: DataPolicy,
  fields: EventAttributes,
  policyDroppedAttributes: number,
): EventAttributes => {
  const decision = transformSignalFields(policy, "event", {
    "event.policy_dropped_attributes": policyDroppedAttributes,
    ...fields,
  });
  return {
    ...decision.value,
    "event.policy_dropped_attributes": policyDroppedAttributes + decision.dropped,
  };
};

const admittedRecord = (
  event: WideEvent,
  auditRecordId?: string,
  auditReservation?: AuditReservation,
): AdmittedRecord => {
  const serialized = JSON.stringify(event);
  const record = { event, serialized, serializedBytes: textEncoder.encode(serialized).byteLength };
  if (auditRecordId === undefined) return record;
  if (auditReservation === undefined) return { ...record, auditRecordId };
  return { ...record, auditRecordId, auditReservation };
};

type MutableAuditPublishState = {
  published: number;
  deduplicated: number;
  dropped: number;
  firstDroppedAt: Option.Option<string>;
  lastDroppedAt: Option.Option<string>;
  unbound: number;
  closed: number;
  queueOverflow: number;
  contractRejected: number;
  policyRejected: number;
  transport: number;
};

const emptyAuditPublishState = (): MutableAuditPublishState => ({
  published: 0,
  deduplicated: 0,
  dropped: 0,
  firstDroppedAt: Option.none(),
  lastDroppedAt: Option.none(),
  unbound: 0,
  closed: 0,
  queueOverflow: 0,
  contractRejected: 0,
  policyRejected: 0,
  transport: 0,
});

const auditPublishReport = (state: MutableAuditPublishState): AuditPublishReport => ({
  published: state.published,
  deduplicated: state.deduplicated,
  dropped: state.dropped,
  firstDroppedAt: state.firstDroppedAt,
  lastDroppedAt: state.lastDroppedAt,
  reasons: {
    unbound: state.unbound,
    closed: state.closed,
    queueOverflow: state.queueOverflow,
    contractRejected: state.contractRejected,
    policyRejected: state.policyRejected,
    transport: state.transport,
  },
});

const incrementAuditDrop = (
  state: MutableAuditPublishState,
  reason: "closed" | "queue-overflow" | "contract-rejected" | "policy-rejected" | "transport",
  droppedAt: string,
): AuditPublishReceipt => {
  state.dropped += 1;
  if (Option.isNone(state.firstDroppedAt)) state.firstDroppedAt = Option.some(droppedAt);
  state.lastDroppedAt = Option.some(droppedAt);
  switch (reason) {
    case "closed":
      state.closed += 1;
      break;
    case "queue-overflow":
      state.queueOverflow += 1;
      break;
    case "contract-rejected":
      state.contractRejected += 1;
      break;
    case "policy-rejected":
      state.policyRejected += 1;
      break;
    case "transport":
      state.transport += 1;
      break;
  }
  return { kind: "dropped", reason };
};

const nativeAuditInput = (fields: EventAttributes): AuditInput => {
  const actorKind = String(fields["audit.actor.kind"]);
  const actorType = actorKind === "service" ? "api" : actorKind === "user" ? "user" : "system";
  const outcome = String(fields["audit.outcome"]);
  const input: AuditInput = {
    action: String(fields["audit.action"]),
    actor: { type: actorType, id: String(fields["audit.actor.id"]) },
    target: {
      type: String(fields["audit.resource.type"]),
      id: String(fields["audit.resource.id"]),
    },
    outcome: outcome === "success" ? "success" : outcome === "denied" ? "denied" : "failure",
    version: AUDIT_SCHEMA_VERSION,
  };
  if (fields["audit.reason_code"] !== undefined) input.reason = String(fields["audit.reason_code"]);
  return input;
};

const safeAdapterFailure = (message: string, cause: EvlogAdapterError): AdapterFailure =>
  new AdapterFailure({
    code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
    message,
    cause,
  });

export const makeEvlogAdapter = (
  options: EvlogAdapterOptions,
  initializeLogger: typeof initLogger = initLogger,
): EvlogAdapter => {
  const dropState = emptyDropState();
  const auditState = emptyAuditPublishState();
  const deliveredAuditRecords = new Map<string, number>();
  const auditReservations = new Map<string, AuditReservation>();
  const loggerOwner = Symbol("evlog-adapter");
  let pendingBytes = 0;
  let pipeline: PipelineDrainFn<AdmittedRecord> | undefined;
  let started = false;
  let detached = false;

  const registration = registerOfficialAdapter({
    name: AdapterName.make("evlog-events"),
    capability: "events",
    stage: "server",
    start: (context) =>
      Effect.gen(function* () {
        const resolvedOptions = yield* resolveOptions(options).pipe(
          Effect.mapError((cause) =>
            safeAdapterFailure(
              "The evlog adapter configuration is invalid. Fix its options before retrying startup.",
              cause,
            ),
          ),
        );
        const clock = yield* Clock.Clock;
        const dropTimestamp = (): string =>
          DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
        const makeAuditReservation = (): AuditReservation => {
          const terminal = Promise.withResolvers<AuditReservationTerminal>();
          return { terminal: terminal.promise, resolve: terminal.resolve };
        };
        const completeAuditReservation = (
          recordId: string,
          reservation: AuditReservation,
          terminal: AuditReservationTerminal,
        ): void => {
          if (auditReservations.get(recordId) === reservation) {
            auditReservations.delete(recordId);
          }
          reservation.resolve(terminal);
        };
        if (context.contract.auditActionByName.size > 0) {
          const auditEventName = context.contract.eventNames.find(
            (candidate) => candidate === "audit.recorded",
          );
          const auditEvent =
            auditEventName === undefined
              ? undefined
              : context.contract.eventByName.get(auditEventName);
          if (
            auditEvent?.kind !== "audit" ||
            auditEvent.defaultSeverity !== "info" ||
            !auditEvent.mandatory ||
            auditEvent.sampling.kind !== "always" ||
            auditEvent.attributes.size !== 0
          ) {
            return yield* safeAdapterFailure(
              "The telemetry contract cannot publish audit records. Add Contract.organizationEvents.AuditRecorded before retrying startup.",
              new EvlogAdapterError({
                code: "OBS_EVLOG_AUDIT_CONTRACT_INVALID",
                message:
                  "Audit publication requires Contract.organizationEvents.AuditRecorded when the contract declares audit actions.",
                cause: "missing audit.recorded organization event",
              }),
            );
          }
        }
        if (Option.isSome(resolvedOptions.requestEventName)) {
          const configuredRequestName = resolvedOptions.requestEventName.value;
          const requestName = context.contract.eventNames.find(
            (candidate) => candidate === configuredRequestName,
          );
          const requestDefinition =
            requestName === undefined ? undefined : context.contract.eventByName.get(requestName);
          if (requestDefinition?.kind !== "request") {
            return yield* safeAdapterFailure(
              "The evlog request event name is invalid. Configure a declared request event name.",
              invalidOptions(
                "The evlog requestEventName must identify a declared contract event with kind request.",
              ),
            );
          }
        }
        if (started) {
          return yield* safeAdapterFailure(
            "The evlog adapter instance is already started. Create one adapter instance per runtime.",
            new EvlogAdapterError({
              code: "OBS_EVLOG_LOGGER_CONFLICT",
              message: "The evlog adapter instance is already started.",
              cause: adapterErrors.LOGGER_CONFLICT(),
            }),
          );
        }
        if (resolvedOptions.installGlobalLogger && globalLoggerOwner !== undefined) {
          return yield* safeAdapterFailure(
            "Another observability evlog adapter already owns the process-global logger.",
            new EvlogAdapterError({
              code: "OBS_EVLOG_LOGGER_CONFLICT",
              message:
                "Another observability evlog adapter already owns the process-global logger.",
              cause: adapterErrors.LOGGER_CONFLICT(),
            }),
          );
        }
        started = true;
        let accepting = true;
        let closePromise: Promise<void> | undefined;
        let probeSequence = 0;
        let observedProbe = 0;
        let integrityTail = Promise.resolve();
        let integrityResult: WideEvent | undefined;
        const integrityDrain: DrainFn | undefined = Option.match(resolvedOptions.auditIntegrity, {
          onNone: () => undefined,
          onSome: (integrity) =>
            auditOnly(
              signed((drainContext) => {
                integrityResult = drainContext.event;
              }, integrity),
              { await: true },
            ),
        });
        const applyAuditIntegrity = (event: WideEvent): Promise<WideEvent> => {
          if (integrityDrain === undefined) return Promise.resolve(event);
          const operation = integrityTail.then(async () => {
            integrityResult = undefined;
            await integrityDrain({ event });
            if (integrityResult === undefined) {
              throw adapterErrors.TRANSPORT_FAILED();
            }
            return integrityResult;
          });
          integrityTail = operation.then(
            () => undefined,
            () => undefined,
          );
          return operation;
        };

        const fallback = (record: AdmittedRecord): void => {
          try {
            if (!resolvedOptions.stdout.write(`${record.serialized}\n`)) {
              incrementReason(dropState, "stdout-unavailable", dropTimestamp());
            }
          } catch {
            incrementReason(dropState, "stdout-unavailable", dropTimestamp());
          }
        };

        const release = (records: ReadonlyArray<AdmittedRecord>): void => {
          for (const record of records)
            pendingBytes = Math.max(0, pendingBytes - record.serializedBytes);
        };

        pipeline = createDrainPipeline<AdmittedRecord>({
          batch: {
            size: resolvedOptions.batchSize,
            intervalMs: resolvedOptions.batchIntervalMillis,
          },
          retry: {
            maxAttempts: resolvedOptions.maximumAttempts,
            backoff: "exponential",
            initialDelayMs: resolvedOptions.initialRetryDelayMillis,
            maxDelayMs: resolvedOptions.maximumRetryDelayMillis,
          },
          maxBufferSize: resolvedOptions.maximumBufferedEvents,
          onDropped: (records, error) => {
            release(records);
            for (const record of records) {
              const droppedAt = dropTimestamp();
              incrementReason(
                dropState,
                error === undefined ? "count-overflow" : "transport",
                droppedAt,
              );
              if (record.auditRecordId !== undefined && record.auditReservation !== undefined) {
                completeAuditReservation(record.auditRecordId, record.auditReservation, "retry");
                incrementAuditDrop(
                  auditState,
                  error === undefined ? "queue-overflow" : "transport",
                  droppedAt,
                );
              }
              fallback(record);
            }
          },
        })(async (records) => {
          try {
            await sendBatchToOTLP(
              records.map((record) => record.event),
              {
                endpoint: context.telemetryConfig.otlpEndpoint.toString(),
                serviceName: context.identity.serviceName,
                resourceAttributes: resourceAttributesFor(context),
                timeout: resolvedOptions.transportTimeoutMillis,
                retries: resolvedOptions.transportRetries,
              },
            );
            for (const record of records) {
              if (record.auditRecordId !== undefined && record.auditReservation !== undefined) {
                deliveredAuditRecords.set(record.auditRecordId, clock.currentTimeMillisUnsafe());
                while (deliveredAuditRecords.size > resolvedOptions.auditDedupeCapacity) {
                  const oldest = deliveredAuditRecords.keys().next().value;
                  if (oldest === undefined) break;
                  deliveredAuditRecords.delete(oldest);
                }
                completeAuditReservation(
                  record.auditRecordId,
                  record.auditReservation,
                  "delivered",
                );
              }
            }
            release(records);
          } catch {
            throw adapterErrors.TRANSPORT_FAILED();
          }
        });

        const offer = (record: AdmittedRecord): OfferResult => {
          if (!accepting) {
            const droppedAt = dropTimestamp();
            incrementReason(dropState, "closed", droppedAt);
            fallback(record);
            return { kind: "closed", droppedAt };
          }
          if (pendingBytes + record.serializedBytes > resolvedOptions.maximumBufferedBytes) {
            const droppedAt = dropTimestamp();
            incrementReason(dropState, "byte-overflow", droppedAt);
            fallback(record);
            return { kind: "queue-overflow", droppedAt };
          }
          if (
            record.auditRecordId !== undefined &&
            (pipeline?.pending ?? 0) >= resolvedOptions.maximumBufferedEvents
          ) {
            const droppedAt = dropTimestamp();
            incrementReason(dropState, "count-overflow", droppedAt);
            fallback(record);
            return { kind: "queue-overflow", droppedAt };
          }
          pendingBytes += record.serializedBytes;
          pipeline?.(record);
          return { kind: "queued" };
        };

        const admitContract = (event: TelemetryEvent, admission: EventAdmissionMetadata) =>
          Effect.gen(function* () {
            const validation = validateContractEvent(
              context.contract,
              event.name,
              event.attributes,
            );
            if (validation instanceof Contract.InvalidTelemetryEvent) return yield* validation;
            if (validation.kind !== event.kind) {
              return yield* new Contract.InvalidTelemetryEvent({
                code: "OBS_EVENT_INVALID_FIELD",
                message: `Event "${event.name}" has kind "${event.kind}" but its contract declares "${validation.kind}".`,
                eventName: event.name,
                attributeName: "event.type",
              });
            }
            const admittedFields = finalCanonicalFields(
              context.policy,
              fieldsForContractEvent(event, event.attributes),
              admission.policyDroppedAttributes,
            );
            const traceId = Option.getOrUndefined(event.correlation.traceId);
            const spanId = Option.getOrUndefined(event.correlation.spanId);
            offer(
              admittedRecord(
                wideEventFor(
                  context,
                  event.timestamp,
                  event.severity,
                  admittedFields,
                  traceId,
                  spanId,
                ),
              ),
            );
          });

        const projectBrowser = (event: BrowserTelemetryEvent) =>
          Effect.gen(function* () {
            if (
              !Number.isFinite(event.occurredAt) ||
              event.occurredAt < 0 ||
              event.occurredAt > BrowserEvents.maxBrowserEventOccurredAt
            ) {
              return yield* new Contract.InvalidTelemetryEvent({
                code: "OBS_EVENT_INVALID_FIELD",
                message: `Event "${event.name}" has an invalid browser occurrence timestamp. Use epoch milliseconds from 0 through ${BrowserEvents.maxBrowserEventOccurredAt}.`,
                eventName: event.name,
                attributeName: "browser.event.occurred_at",
              });
            }
            const timestamp = new Date(event.occurredAt).toISOString();
            const validation = validateContractEvent(
              context.contract,
              event.name,
              event.attributes,
            );
            if (validation instanceof Contract.InvalidTelemetryEvent) return yield* validation;
            if (validation.kind === "defect" && event.error === undefined) {
              return yield* new Contract.InvalidTelemetryEvent({
                code: "OBS_EVENT_INVALID_FIELD",
                message: `Defect event "${event.name}" requires a typed browser error member.`,
                eventName: event.name,
                attributeName: "error",
              });
            }
            if (validation.kind !== "defect" && event.error !== undefined) {
              return yield* new Contract.InvalidTelemetryEvent({
                code: "OBS_EVENT_INVALID_FIELD",
                message: `Non-defect event "${event.name}" cannot carry a browser error member.`,
                eventName: event.name,
                attributeName: "error",
              });
            }
            const projected: { [attributeName: string]: Contract.AttributeValue } = {
              "event.name": event.name,
              "event.kind": "wide",
              "event.type": validation.kind,
              "event.severity": validation.defaultSeverity,
              "event.outcome": validation.kind === "defect" ? "failure" : "success",
              "event.timestamp": timestamp,
              "event.source": "browser",
              "browser.event.id": event.id,
              "browser.event.occurred_at": event.occurredAt,
              ...event.attributes,
            };
            if (event.error !== undefined) {
              const structured = createError({
                code: event.error.type,
                message: event.error.message,
                status: event.error.retryable ? 503 : 500,
              });
              projected["error.type"] = structured.code ?? structured.name;
              projected["error.name"] = structured.name;
              projected["error.message"] = structured.message;
              projected["error.status"] = structured.status;
              projected["error.retryable"] = event.error.retryable;
            }
            return admittedRecord(
              wideEventFor(
                context,
                timestamp,
                validation.defaultSeverity,
                finalCanonicalFields(
                  context.policy,
                  projected,
                  event.admission.policyDroppedAttributes,
                ),
              ),
            );
          });

        const admitBrowserBatch = (events: ReadonlyArray<BrowserTelemetryEvent>) =>
          Effect.gen(function* () {
            const records = yield* Effect.forEach(events, projectBrowser);
            for (const record of records) offer(record);
          });

        const admitGlobal = (drainContext: DrainContext): void => {
          if (drainContext.event.audit !== undefined) {
            incrementReason(dropState, "contract-rejected", dropTimestamp());
            return;
          }
          const timestamp = normalizeGlobalTimestamp(drainContext.event.timestamp);
          if (Option.isNone(timestamp)) {
            incrementReason(dropState, "contract-rejected", dropTimestamp());
            return;
          }
          drainContext.event.timestamp = timestamp.value;
          let rawName = decodeString(drainContext.event["event.name"]);
          if (
            Option.isNone(rawName) &&
            Option.isSome(resolvedOptions.requestEventName) &&
            drainContext.request !== undefined
          ) {
            drainContext.event["event.name"] = resolvedOptions.requestEventName.value;
            rawName = resolvedOptions.requestEventName;
          }
          if (Option.isNone(rawName)) {
            incrementReason(dropState, "contract-rejected", dropTimestamp());
            return;
          }
          const eventName = context.contract.eventNames.find(
            (candidate) => candidate === rawName.value,
          );
          const definition =
            eventName === undefined ? undefined : context.contract.eventByName.get(eventName);
          if (definition === undefined) {
            incrementReason(dropState, "contract-rejected", dropTimestamp());
            return;
          }
          const traceId = decodeTraceId(drainContext.event.traceId);
          const spanId = decodeSpanId(drainContext.event.spanId);
          if (
            (drainContext.event.traceId !== undefined && Option.isNone(traceId)) ||
            (drainContext.event.spanId !== undefined && Option.isNone(spanId))
          ) {
            incrementReason(dropState, "contract-rejected", dropTimestamp());
            return;
          }
          const attributes: { [attributeName: string]: Contract.AttributeValue } = {};
          for (const [name, value] of Object.entries(drainContext.event)) {
            if (globalEnvelopeFields.has(name)) continue;
            const scalar = decodeScalar(value);
            if (Option.isNone(scalar)) {
              incrementReason(dropState, "contract-rejected", dropTimestamp());
              return;
            }
            attributes[name] = scalar.value;
          }
          const validation = validateContractEvent(context.contract, rawName.value, attributes);
          if (validation instanceof Contract.InvalidTelemetryEvent) {
            incrementReason(dropState, "contract-rejected", dropTimestamp());
            return;
          }
          const fields: { [attributeName: string]: Contract.AttributeValue } = {
            "event.name": rawName.value,
            "event.kind": "wide",
            "event.type": definition.kind,
            "event.severity": definition.defaultSeverity,
            "event.outcome": "success",
            "event.timestamp": timestamp.value,
            ...attributes,
          };
          if (definition.kind === "request") {
            const method = decodeString(drainContext.request?.method);
            const path = decodeString(drainContext.request?.path);
            const requestId = decodeString(drainContext.request?.requestId);
            const status = decodeNumber(drainContext.event.status);
            const duration = decodeNumber(drainContext.event.duration);
            if (Option.isSome(method)) fields["http.request.method"] = method.value;
            if (Option.isSome(path)) fields["http.route"] = path.value;
            if (Option.isSome(requestId)) fields["request.id"] = requestId.value;
            if (Option.isSome(status)) fields["http.response.status_code"] = status.value;
            if (Option.isSome(duration)) fields["event.duration_ms"] = duration.value;
          }
          offer(
            admittedRecord(
              wideEventFor(
                context,
                timestamp.value,
                definition.defaultSeverity,
                finalCanonicalFields(context.policy, fields, 0),
                Option.getOrUndefined(traceId),
                Option.getOrUndefined(spanId),
              ),
            ),
          );
        };

        const globalDrain = (drainContext: DrainContext): void => {
          const probe = decodeString(drainContext.event["observability.probe"]);
          if (Option.isSome(probe)) {
            observedProbe = Number(probe.value);
            return;
          }
          admitGlobal(drainContext);
        };

        const probeLogger = (): boolean => {
          probeSequence += 1;
          log.info({ "observability.probe": String(probeSequence) });
          return observedProbe === probeSequence;
        };

        if (resolvedOptions.installGlobalLogger) {
          globalLoggerOwner = loggerOwner;
          try {
            initializeLogger({
              silent: true,
              pretty: false,
              redact: false,
              env: {
                service: context.identity.serviceName,
                environment: context.identity.environment,
                version: context.identity.serviceVersion,
              },
              drain: globalDrain,
            });
          } catch (cause) {
            globalLoggerOwner = undefined;
            started = false;
            return yield* safeAdapterFailure(
              "The evlog process-global logger could not be initialized.",
              new EvlogAdapterError({
                code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
                message: "The evlog process-global logger initialization failed.",
                cause,
              }),
            );
          }
        }

        const admitAudit = (record: CommittedAuditRecord): Effect.Effect<AuditPublishReceipt> =>
          Effect.promise<AuditPublishReceipt>(async () => {
            const declaredAction = context.contract.auditActionByName.get(record.action);
            if (
              declaredAction === undefined ||
              declaredAction.resourceType !== record.resource.type ||
              !declaredAction.allowedOutcomes.includes(record.outcome) ||
              (Option.isSome(record.reasonCode) &&
                !declaredAction.reasonCodes.includes(record.reasonCode.value))
            ) {
              return incrementAuditDrop(auditState, "contract-rejected", dropTimestamp());
            }
            while (true) {
              const now = clock.currentTimeMillisUnsafe();
              for (const [recordId, deliveredAt] of deliveredAuditRecords) {
                if (now - deliveredAt > resolvedOptions.auditDedupeWindowMillis) {
                  deliveredAuditRecords.delete(recordId);
                }
              }
              if (accepting && deliveredAuditRecords.has(record.recordId)) {
                auditState.deduplicated += 1;
                return { kind: "deduplicated" };
              }
              const existingReservation = auditReservations.get(record.recordId);
              if (existingReservation !== undefined) {
                const terminal = await existingReservation.terminal;
                if (terminal === "delivered" && accepting) {
                  auditState.deduplicated += 1;
                  return { kind: "deduplicated" };
                }
                continue;
              }
              const recordId = record.recordId;
              const fields: { [attributeName: string]: Contract.AttributeValue } = {
                "event.name": "audit.recorded",
                "event.kind": "wide",
                "event.type": "audit",
                "event.severity": "info",
                "event.outcome": record.outcome === "success" ? "success" : "failure",
                "event.timestamp": record.committedAt,
                "audit.action": record.action,
                "audit.actor.kind": record.actor.kind,
                "audit.actor.id": record.actor.kind === "system" ? "system" : record.actor.id,
                "audit.resource.type": record.resource.type,
                "audit.resource.id": record.resource.id,
                "audit.outcome": record.outcome,
                "audit.record.id": recordId,
                "audit.record.hash": record.ledgerHash,
                "audit.occurred_at": record.occurredAt,
                "audit.schema_version": record.schemaVersion,
              };
              if (Option.isSome(record.reasonCode)) {
                fields["audit.reason_code"] = record.reasonCode.value;
              }
              if (Option.isSome(record.tenantId)) fields["audit.tenant.id"] = record.tenantId.value;
              if (Option.isSome(record.correlation.requestId)) {
                fields["request.id"] = record.correlation.requestId.value;
              }
              if (Option.isSome(record.correlation.runId)) {
                fields["run.id"] = record.correlation.runId.value;
              }
              if (Option.isSome(record.correlation.traceId)) {
                fields["trace.id"] = record.correlation.traceId.value;
              }
              if (Option.isSome(record.correlation.spanId)) {
                fields["span.id"] = record.correlation.spanId.value;
              }
              const immutableAnchorNames = [
                "event.outcome",
                "event.timestamp",
                "audit.record.id",
                "audit.record.hash",
                "audit.action",
                "audit.actor.kind",
                "audit.resource.type",
                "audit.outcome",
                "audit.schema_version",
              ];
              const decision = transformSignalFields(context.policy, "audit", fields);
              const admittedFields: EventAttributes = {
                ...decision.value,
                "event.policy_dropped_attributes": decision.dropped,
              };
              const requiredFieldNames = [
                ...immutableAnchorNames,
                "audit.actor.id",
                "audit.resource.id",
                "audit.occurred_at",
              ];
              if (
                requiredFieldNames.some((name) => decision.value[name] === undefined) ||
                immutableAnchorNames.some((name) => decision.value[name] !== fields[name])
              ) {
                return incrementAuditDrop(auditState, "policy-rejected", dropTimestamp());
              }
              const reservation = makeAuditReservation();
              auditReservations.set(recordId, reservation);
              const native = {
                ...buildAuditFields(nativeAuditInput(admittedFields)),
                idempotencyKey: String(admittedFields["audit.record.id"]),
              };
              const nativeContext: { [name: string]: string } = {};
              if (admittedFields["request.id"] !== undefined) {
                nativeContext.requestId = String(admittedFields["request.id"]);
              }
              if (admittedFields["trace.id"] !== undefined) {
                nativeContext.traceId = String(admittedFields["trace.id"]);
              }
              if (admittedFields["audit.tenant.id"] !== undefined) {
                nativeContext.tenantId = String(admittedFields["audit.tenant.id"]);
              }
              if (Object.keys(nativeContext).length > 0) native.context = nativeContext;
              const traceId = decodeTraceId(admittedFields["trace.id"]);
              const spanId = decodeSpanId(admittedFields["span.id"]);
              const event = Object.assign(
                wideEventFor(
                  context,
                  record.committedAt,
                  "info",
                  admittedFields,
                  Option.getOrUndefined(traceId),
                  Option.getOrUndefined(spanId),
                ),
                { audit: native },
              );
              let integrityEvent: WideEvent;
              try {
                integrityEvent = await applyAuditIntegrity(event);
              } catch {
                completeAuditReservation(recordId, reservation, "retry");
                return incrementAuditDrop(auditState, "transport", dropTimestamp());
              }
              const admission = offer(admittedRecord(integrityEvent, recordId, reservation));
              if (admission.kind !== "queued") {
                completeAuditReservation(recordId, reservation, "retry");
                return incrementAuditDrop(auditState, admission.kind, admission.droppedAt);
              }
              auditState.published += 1;
              return { kind: "published" };
            }
          });

        const auditLayer = Layer.succeed(
          AuditPublisher,
          AuditPublisher.of({ publish: admitAudit, report: () => auditPublishReport(auditState) }),
        );

        const eventLayer = Layer.succeed(
          TelemetryEventSink,
          TelemetryEventSink.of({
            record: (event, admission) =>
              Effect.suspend(() => {
                if (resolvedOptions.installGlobalLogger && !detached && !probeLogger()) {
                  detached = true;
                }
                return admitContract(event, admission);
              }),
            recordBrowserBatch: admitBrowserBatch,
          }),
        );

        const flush = Effect.promise(() => pipeline?.flush() ?? Promise.resolve());
        const close = Effect.promise(() => {
          accepting = false;
          const activePipeline = pipeline;
          const pending =
            closePromise ??
            (activePipeline?.flush() ?? Promise.resolve())
              .then(() => activePipeline?.settled() ?? Promise.resolve())
              .then(() => {
                if (globalLoggerOwner !== loggerOwner) return;
                if (!detached && !probeLogger()) detached = true;
                if (!detached) initializeLogger({ enabled: false });
                globalLoggerOwner = undefined;
              });
          closePromise = pending;
          return pending;
        });
        return {
          flush,
          close,
          eventLayer: Option.some(eventLayer),
          auditLayer: Option.some(auditLayer),
          degraded: () => dropState.total > 0 || auditState.dropped > 0 || detached,
        };
      }),
  });

  return {
    registration,
    drops: () => reportFor(dropState),
    pending: () => ({ count: pipeline?.pending ?? 0, serializedBytes: pendingBytes }),
  };
};

export const evlogAdapter = (options: EvlogAdapterOptions = {}): EvlogAdapter =>
  makeEvlogAdapter(options);
