import {
  AdapterFailure,
  AdapterName,
  Contract,
  instanceResourceAttributes,
  registerOfficialAdapter,
  TelemetryEventSink,
  transformSignalFields,
  type BrowserTelemetryEvent,
  type ContractRegistry,
  type EventAttributes,
  type OfficialAdapterRegistration,
  type ObservabilityAdapterContext,
  type TelemetryEvent,
} from "@equipe-tech/observability";
import {
  createError,
  defineErrorCatalog,
  getEnvironment,
  initLogger,
  log,
  type DrainContext,
  type WideEvent,
} from "evlog";
import { sendBatchToOTLP } from "evlog/otlp";
import { createDrainPipeline } from "evlog/pipeline";
import { Effect, Layer, Option, Schema } from "effect";
import { EvlogAdapterError } from "./EvlogAdapterError.ts";

export type EvlogDropReason =
  | "count-overflow"
  | "byte-overflow"
  | "transport"
  | "stdout-unavailable"
  | "logger-detached"
  | "contract-rejected"
  | "policy-rejected"
  | "closed";

export type EvlogDropReasonCounts = {
  readonly countOverflow: number;
  readonly byteOverflow: number;
  readonly transport: number;
  readonly stdoutUnavailable: number;
  readonly loggerDetached: number;
  readonly contractRejected: number;
  readonly policyRejected: number;
  readonly closed: number;
};

export type EvlogDropReport = {
  readonly total: number;
  readonly firstDroppedAt: string | undefined;
  readonly lastDroppedAt: string | undefined;
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
  firstDroppedAt: string | undefined;
  lastDroppedAt: string | undefined;
  countOverflow: number;
  byteOverflow: number;
  transport: number;
  stdoutUnavailable: number;
  loggerDetached: number;
  contractRejected: number;
  policyRejected: number;
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
const textEncoder = new TextEncoder();
const initialGlobalEnvironment = { ...getEnvironment() };
let adapterOwnsGlobalLogger = false;

const defaultOutput: EvlogOutput = {
  write: (line) => process.stdout.write(line),
};

const resolveOptions = (options: EvlogAdapterOptions): ResolvedOptions => {
  if (Option.isNone(decodeOptions(options))) {
    throw new EvlogAdapterError({
      code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
      message:
        "The evlog adapter configuration is invalid. Use positive integer queue and timing limits and a non-negative retry count.",
      cause: createError({
        code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
        message: "The evlog adapter configuration is invalid.",
        status: 500,
      }),
    });
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
    throw new EvlogAdapterError({
      code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
      message:
        "The evlog batch size exceeds the event queue limit. Set batchSize at or below maximumBufferedEvents.",
      cause: createError({
        code: "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
        message: "The evlog batch size exceeds the queue limit.",
        status: 500,
      }),
    });
  }
  return resolved;
};

const emptyDropState = (): MutableDropState => ({
  total: 0,
  firstDroppedAt: undefined,
  lastDroppedAt: undefined,
  countOverflow: 0,
  byteOverflow: 0,
  transport: 0,
  stdoutUnavailable: 0,
  loggerDetached: 0,
  contractRejected: 0,
  policyRejected: 0,
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
    loggerDetached: state.loggerDetached,
    contractRejected: state.contractRejected,
    policyRejected: state.policyRejected,
    closed: state.closed,
  },
});

const incrementReason = (state: MutableDropState, reason: EvlogDropReason): void => {
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
    case "logger-detached":
      state.loggerDetached += 1;
      break;
    case "contract-rejected":
      state.contractRejected += 1;
      break;
    case "policy-rejected":
      state.policyRejected += 1;
      break;
    case "closed":
      state.closed += 1;
      break;
  }
  const droppedAt = new Date().toISOString();
  state.total += 1;
  state.firstDroppedAt ??= droppedAt;
  state.lastDroppedAt = droppedAt;
};

const definitionFor = (contract: ContractRegistry, name: string) => {
  const eventName = contract.eventNames.find((candidate) => candidate === name);
  return eventName === undefined ? undefined : contract.eventByName.get(eventName);
};

const contractError = (message: string, eventName: string, attributeName?: string) =>
  attributeName === undefined
    ? new Contract.InvalidTelemetryEvent({
        code: "OBS_EVENT_UNKNOWN_NAME",
        message,
        eventName,
      })
    : new Contract.InvalidTelemetryEvent({
        code: "OBS_EVENT_UNDECLARED_ATTRIBUTE",
        message,
        eventName,
        attributeName,
      });

const validateAttributes = (
  contract: ContractRegistry,
  eventName: string,
  attributes: EventAttributes,
) => {
  const definition = definitionFor(contract, eventName);
  if (definition === undefined) {
    return contractError(
      `Event "${eventName}" is not declared by the telemetry contract. Use a declared canonical event name.`,
      eventName,
    );
  }
  for (const required of definition.requiredAttributes) {
    if (!Object.hasOwn(attributes, required)) {
      return new Contract.InvalidTelemetryEvent({
        code: "OBS_EVENT_MISSING_ATTRIBUTE",
        message: `Event "${eventName}" is missing required attribute "${required}".`,
        eventName,
        attributeName: required,
      });
    }
  }
  for (const attributeName of Object.keys(attributes)) {
    if (!definition.attributes.has(attributeName)) {
      return contractError(
        `Event "${eventName}" does not declare attribute "${attributeName}".`,
        eventName,
        attributeName,
      );
    }
  }
  return definition;
};

const fieldsForContractEvent = (event: TelemetryEvent): EventAttributes => {
  const fields: { [attributeName: string]: Contract.AttributeValue } = {
    "event.name": event.name,
    "event.kind": "wide",
    "event.type": event.kind,
    "event.severity": event.severity,
    "event.outcome": event.outcome,
    "event.timestamp": event.timestamp,
  };
  for (const [name, value] of Object.entries(event.attributes)) fields[name] = value;
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
    case "defect":
      fields["error.type"] = event.error.type;
      fields["error.message"] = event.error.message;
      fields["error.retryable"] = event.error.retryable;
      break;
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

const globalEnvironmentIsInitial = (): boolean => {
  const current = getEnvironment();
  return (
    current.service === initialGlobalEnvironment.service &&
    current.environment === initialGlobalEnvironment.environment &&
    current.version === initialGlobalEnvironment.version &&
    current.commitHash === initialGlobalEnvironment.commitHash &&
    current.region === initialGlobalEnvironment.region
  );
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

export const makeEvlogAdapter = (options: ResolvedOptions): EvlogAdapter => {
  const dropState = emptyDropState();
  let pendingBytes = 0;
  let pipelinePending = 0;
  let started = false;
  let detached = false;

  const registration = registerOfficialAdapter({
    name: AdapterName.make("evlog-events"),
    capability: "events",
    stage: "server",
    start: (context) =>
      Effect.gen(function* () {
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
        if (
          options.installGlobalLogger &&
          (adapterOwnsGlobalLogger || !globalEnvironmentIsInitial())
        ) {
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
            if (!options.stdout.write(`${record.serialized}\n`)) {
              incrementReason(dropState, "stdout-unavailable");
            }
          } catch {
            incrementReason(dropState, "stdout-unavailable");
          }
        };

        const release = (records: ReadonlyArray<AdmittedRecord>): void => {
          for (const record of records)
            pendingBytes = Math.max(0, pendingBytes - record.serializedBytes);
          pipelinePending = Math.max(0, pipelinePending - records.length);
        };

        const pipeline = createDrainPipeline<AdmittedRecord>({
          batch: { size: options.batchSize, intervalMs: options.batchIntervalMillis },
          retry: {
            maxAttempts: options.maximumAttempts,
            backoff: "exponential",
            initialDelayMs: options.initialRetryDelayMillis,
            maxDelayMs: options.maximumRetryDelayMillis,
          },
          maxBufferSize: options.maximumBufferedEvents,
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
                timeout: options.transportTimeoutMillis,
                retries: options.transportRetries,
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
          if (pendingBytes + record.serializedBytes > options.maximumBufferedBytes) {
            incrementReason(dropState, "byte-overflow");
            fallback(record);
            return;
          }
          pendingBytes += record.serializedBytes;
          pipelinePending += 1;
          pipeline(record);
        };

        const admitContract = (event: TelemetryEvent) =>
          Effect.gen(function* () {
            const validation = validateAttributes(context.contract, event.name, event.attributes);
            if (validation instanceof Contract.InvalidTelemetryEvent) return yield* validation;
            if (validation.kind !== event.kind) {
              return yield* new Contract.InvalidTelemetryEvent({
                code: "OBS_EVENT_INVALID_FIELD",
                message: `Event "${event.name}" has kind "${event.kind}" but its contract declares "${validation.kind}".`,
                eventName: event.name,
                attributeName: "event.type",
              });
            }
            const projected = fieldsForContractEvent(event);
            const decision = transformSignalFields(context.policy, "event", projected);
            const admittedFields = {
              ...decision.value,
              "event.policy_dropped_attributes": decision.dropped,
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
            const validation = validateAttributes(context.contract, event.name, event.attributes);
            if (validation instanceof Contract.InvalidTelemetryEvent) return yield* validation;
            const projected: { [attributeName: string]: Contract.AttributeValue } = {
              "event.name": event.name,
              "event.kind": "wide",
              "event.type": validation.kind,
              "event.severity": validation.defaultSeverity,
              "event.outcome": "success",
              "event.timestamp": new Date(event.occurredAt).toISOString(),
              "event.source": "browser",
              "browser.event.id": event.id,
              ...event.attributes,
            };
            const decision = transformSignalFields(context.policy, "event", projected);
            const admittedFields = {
              ...decision.value,
              "event.policy_dropped_attributes": event.policyDroppedAttributes + decision.dropped,
            };
            offer(
              admittedRecord(
                wideEventFor(
                  context,
                  new Date(event.occurredAt).toISOString(),
                  validation.defaultSeverity,
                  admittedFields,
                ),
              ),
            );
          });

        const admitGlobal = (drainContext: DrainContext): void => {
          const rawName = decodeString(drainContext.event["event.name"]);
          if (Option.isNone(rawName)) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const definition = definitionFor(context.contract, rawName.value);
          if (definition === undefined) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const attributes: { [attributeName: string]: Contract.AttributeValue } = {};
          for (const [name, value] of Object.entries(drainContext.event)) {
            if (!definition.attributes.has(name)) continue;
            const scalar = decodeScalar(value);
            if (Option.isNone(scalar)) {
              incrementReason(dropState, "contract-rejected");
              return;
            }
            attributes[name] = scalar.value;
          }
          const validation = validateAttributes(context.contract, rawName.value, attributes);
          if (validation instanceof Contract.InvalidTelemetryEvent) {
            incrementReason(dropState, "contract-rejected");
            return;
          }
          const decision = transformSignalFields(context.policy, "event", attributes);
          if (decision.dropped > 0) incrementReason(dropState, "policy-rejected");
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

        if (options.installGlobalLogger) {
          adapterOwnsGlobalLogger = true;
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
          if (!probeLogger()) {
            return yield* safeAdapterFailure(
              "The evlog global logger sentinel did not reach the adapter drain.",
              new EvlogAdapterError({
                code: "OBS_EVLOG_LOGGER_CONFLICT",
                message: "The evlog global logger sentinel did not reach the adapter drain.",
                cause: adapterErrors.LOGGER_CONFLICT(),
              }),
            );
          }
        }

        const eventLayer = Layer.succeed(
          TelemetryEventSink,
          TelemetryEventSink.of({
            record: (event) =>
              Effect.suspend(() => {
                if (options.installGlobalLogger && !probeLogger() && !detached) {
                  detached = true;
                  incrementReason(dropState, "logger-detached");
                }
                return admitContract(event);
              }),
            recordBrowser: admitBrowser,
          }),
        );

        const flush = Effect.tryPromise({
          try: () => pipeline.flush(),
          catch: (cause) =>
            safeAdapterFailure(
              "The evlog pipeline flush failed. Retry close within the remaining lifecycle budget.",
              new EvlogAdapterError({
                code: "OBS_EVLOG_EVENT_REJECTED",
                message: "The evlog pipeline flush failed.",
                cause,
              }),
            ),
        });
        const close = Effect.tryPromise({
          try: () => {
            accepting = false;
            closePromise ??= pipeline.flush().then(() => pipeline.settled());
            return closePromise;
          },
          catch: (cause) =>
            safeAdapterFailure(
              "The evlog pipeline close failed. Retry close within the forced cleanup budget.",
              new EvlogAdapterError({
                code: "OBS_EVLOG_EVENT_REJECTED",
                message: "The evlog pipeline close failed.",
                cause,
              }),
            ),
        });
        return {
          flush,
          close,
          eventLayer,
          degraded: () => dropState.stdoutUnavailable > 0 || dropState.loggerDetached > 0,
        };
      }),
  });

  return {
    registration,
    drops: () => reportFor(dropState),
    pending: () => ({ count: pipelinePending, serializedBytes: pendingBytes }),
  };
};

export const evlogAdapter = (options: EvlogAdapterOptions = {}): EvlogAdapter =>
  makeEvlogAdapter(resolveOptions(options));
