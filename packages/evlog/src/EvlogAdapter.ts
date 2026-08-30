import {
  AdapterFailure,
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
  type EventAdmissionMetadata,
  type EventAttributes,
  type OfficialAdapterRegistration,
  type ObservabilityAdapterContext,
  type TelemetryEvent,
} from "@equipe-tech/observability";
import {
  createError,
  defineErrorCatalog,
  initLogger,
  log,
  type DrainContext,
  type WideEvent,
} from "evlog";
import { sendBatchToOTLP } from "evlog/otlp";
import { createDrainPipeline, type PipelineDrainFn } from "evlog/pipeline";
import { Effect, Layer, Option, Schema } from "effect";
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
  readonly stdout: EvlogOutput;
};

type AdmittedRecord = {
  readonly event: WideEvent;
  readonly serialized: string;
  readonly serializedBytes: number;
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
    message: "Another evlog logger owns the process-global logger.",
  },
  CONTRACT_EVENT: {
    status: 500,
    message: "A contract defect event was recorded.",
  },
});

const positiveInteger = Schema.Int.check(Schema.makeFilter((value) => value > 0));
const nonNegativeInteger = Schema.Int.check(Schema.makeFilter((value) => value >= 0));
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
  stdout: Schema.optional(
    Schema.Struct({
      write: Schema.instanceOf(Function),
    }),
  ),
});
const decodeOptions = Schema.decodeUnknownOption(AdapterOptionsDocument);
const decodeString = Schema.decodeUnknownOption(Schema.String);
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

const incrementReason = (state: MutableDropState, reason: DropReason): void => {
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
  const droppedAt = new Date().toISOString();
  state.total += 1;
  if (Option.isNone(state.firstDroppedAt)) state.firstDroppedAt = Option.some(droppedAt);
  state.lastDroppedAt = Option.some(droppedAt);
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
      const catalogError = adapterErrors.CONTRACT_EVENT({
        message: event.error.message,
        status: event.error.retryable ? 503 : 500,
      });
      const structured = createError({
        code: adapterErrors.CONTRACT_EVENT.code,
        message: catalogError.message,
        status: catalogError.status,
      });
      fields["error.type"] = event.error.type;
      fields["error.message"] = structured.message;
      fields["error.retryable"] = event.error.retryable;
      break;
    }
    case "audit":
      fields["audit.action"] = event.audit.action;
      fields["audit.actor.kind"] = event.audit.actor.kind;
      if (event.audit.actor.kind !== "system") fields["audit.actor.id"] = event.audit.actor.id;
      fields["audit.resource.type"] = event.audit.resourceType;
      fields["audit.resource.id"] = event.audit.resourceId;
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

const admittedRecord = (event: WideEvent): AdmittedRecord => {
  const serialized = JSON.stringify(event);
  return { event, serialized, serializedBytes: textEncoder.encode(serialized).byteLength };
};

const safeAdapterFailure = (message: string, cause: EvlogAdapterError): AdapterFailure =>
  new AdapterFailure({
    code: "OBS_OBSERVABILITY_ADAPTER_FAILED",
    message,
    cause,
  });

const makeEvlogAdapter = (options: EvlogAdapterOptions): EvlogAdapter => {
  const dropState = emptyDropState();
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
            "Another evlog logger already owns the process-global logger.",
            new EvlogAdapterError({
              code: "OBS_EVLOG_LOGGER_CONFLICT",
              message: "Another evlog logger already owns the process-global logger.",
              cause: adapterErrors.LOGGER_CONFLICT(),
            }),
          );
        }
        started = true;
        let accepting = true;
        let closePromise: Promise<void> | undefined;
        let probeSequence = 0;
        let observedProbe = 0;

        const fallback = (record: AdmittedRecord): void => {
          try {
            if (!resolvedOptions.stdout.write(`${record.serialized}\n`)) {
              incrementReason(dropState, "stdout-unavailable");
            }
          } catch {
            incrementReason(dropState, "stdout-unavailable");
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
              incrementReason(dropState, error === undefined ? "count-overflow" : "transport");
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
            release(records);
          } catch {
            throw adapterErrors.TRANSPORT_FAILED();
          }
        });

        const offer = (record: AdmittedRecord): void => {
          if (!accepting) {
            incrementReason(dropState, "closed");
            fallback(record);
            return;
          }
          if (pendingBytes + record.serializedBytes > resolvedOptions.maximumBufferedBytes) {
            incrementReason(dropState, "byte-overflow");
            fallback(record);
            return;
          }
          pendingBytes += record.serializedBytes;
          pipeline?.(record);
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
            const decision = transformSignalFields(context.policy, "event", event.attributes);
            const admittedFields = {
              ...fieldsForContractEvent(event, decision.value),
              "event.policy_dropped_attributes":
                admission.policyDroppedAttributes + decision.dropped,
            };
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

        const admitBrowser = (event: BrowserTelemetryEvent) =>
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
            const projected: { [attributeName: string]: Contract.AttributeValue } = {
              "event.name": event.name,
              "event.kind": "wide",
              "event.type": validation.kind,
              "event.severity": validation.defaultSeverity,
              "event.outcome": "success",
              "event.timestamp": timestamp,
              "event.source": "browser",
              "browser.event.id": event.id,
              "browser.event.occurred_at": event.occurredAt,
              ...event.attributes,
            };
            const decision = transformSignalFields(context.policy, "event", projected);
            const admittedFields = {
              ...decision.value,
              "event.policy_dropped_attributes":
                event.admission.policyDroppedAttributes + decision.dropped,
            };
            offer(
              admittedRecord(
                wideEventFor(context, timestamp, validation.defaultSeverity, admittedFields),
              ),
            );
          });

        const admitGlobal = (drainContext: DrainContext): void => {
          const rawName = decodeString(drainContext.event["event.name"]);
          if (Option.isNone(rawName)) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const eventName = context.contract.eventNames.find(
            (candidate) => candidate === rawName.value,
          );
          const definition =
            eventName === undefined ? undefined : context.contract.eventByName.get(eventName);
          if (definition === undefined) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const traceId = decodeTraceId(drainContext.event.traceId);
          const spanId = decodeSpanId(drainContext.event.spanId);
          if (
            (drainContext.event.traceId !== undefined && Option.isNone(traceId)) ||
            (drainContext.event.spanId !== undefined && Option.isNone(spanId))
          ) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const attributes: { [attributeName: string]: Contract.AttributeValue } = {};
          for (const [name, value] of Object.entries(drainContext.event)) {
            if (globalEnvelopeFields.has(name)) continue;
            const scalar = decodeScalar(value);
            if (Option.isNone(scalar)) {
              incrementReason(dropState, "contract-rejected");
              return;
            }
            attributes[name] = scalar.value;
          }
          const validation = validateContractEvent(context.contract, rawName.value, attributes);
          if (validation instanceof Contract.InvalidTelemetryEvent) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const decision = transformSignalFields(context.policy, "event", attributes);
          const fields: { [attributeName: string]: Contract.AttributeValue } = {
            "event.name": rawName.value,
            "event.kind": "wide",
            "event.type": definition.kind,
            "event.severity": definition.defaultSeverity,
            "event.outcome": "success",
            "event.timestamp": drainContext.event.timestamp,
            "event.policy_dropped_attributes": decision.dropped,
            ...decision.value,
          };
          offer(
            admittedRecord(
              wideEventFor(
                context,
                drainContext.event.timestamp,
                definition.defaultSeverity,
                fields,
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
          initLogger({
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
        }

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
            recordBrowser: admitBrowser,
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
                if (globalLoggerOwner === loggerOwner) {
                  initLogger({ enabled: false });
                  globalLoggerOwner = undefined;
                }
              });
          closePromise = pending;
          return pending;
        });
        return {
          flush,
          close,
          eventLayer: Option.some(eventLayer),
          degraded: () => dropState.total > 0 || detached,
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
