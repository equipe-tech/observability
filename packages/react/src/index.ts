import { reactWebLifecycle } from "@equipe-tech/observability/react-web-profile";
import {
  createBrowserTelemetryClient,
  type BrowserTelemetryClient,
  type BrowserTelemetryClientConfig,
  type BrowserTelemetryClientTransport,
} from "@equipe-tech/observability/browser/client";
import {
  defectDeduplicator,
  parseDataPolicy,
  parseResourceIdentity,
  sanitizeDefectEnvelope,
  transformSignalFields,
  unexpectedDefect,
  type DataPolicy,
  type DataPolicyInput,
  type ResourceIdentity,
} from "@equipe-tech/observability/policy";
import { parseSentryDsn } from "@equipe-tech/observability-sentry";
import {
  createBrowserSentryDefectReporter,
  type BrowserSentryDefectReporter,
  type BrowserSentryDefectReporterConfig,
  type SentryDefectReport,
} from "@equipe-tech/observability-sentry/browser";
import { Effect, Option, Predicate, Schema } from "effect";

export type BrowserServiceIdentity = {
  readonly name: string;
  readonly version: string;
  readonly environment: string;
};

export type BrowserEventHost = {
  readonly addEventListener: (name: string, listener: (event: Event) => void) => void;
  readonly removeEventListener: (name: string, listener: (event: Event) => void) => void;
};

export type BrowserObservabilityConfig = {
  readonly service: BrowserServiceIdentity;
  readonly policy: DataPolicyInput;
  readonly events?: Omit<BrowserTelemetryClientConfig, "disabled" | "policy" | "shutdownTimeoutMs">;
  readonly sentry?: {
    readonly dsn?: string;
    readonly disabled?: boolean;
    readonly componentStack?: boolean;
  };
  readonly dedupeWindowMillis?: number;
  readonly dedupeCapacity?: number;
  readonly host?: BrowserEventHost;
};

export type DefectOrigin =
  | "window.error"
  | "unhandled.rejection"
  | "react.uncaught"
  | "react.caught"
  | "react.recoverable"
  | "manual";

export type DefectReportInput = {
  readonly error: Error;
  readonly origin: DefectOrigin;
  readonly code?: string;
  readonly componentStack?: string;
};

export type DefectDestinationState = {
  readonly sentry: "not-attempted" | "queued" | "disabled" | "failed";
  readonly events: "not-attempted" | "queued" | "failed";
};

export type DefectOutcome =
  | {
      readonly kind: "recorded";
      readonly eventId: string;
      readonly destinations: DefectDestinationState;
    }
  | {
      readonly kind: "failed";
      readonly destinations: DefectDestinationState;
    }
  | { readonly kind: "deduplicated"; readonly reason: "identity" | "fingerprint" }
  | { readonly kind: "suppressed"; readonly reason: "policy" | "closed" | "not-installed" };

export type ReactErrorInfo = { readonly componentStack?: string };
export type ReactRootErrorOptions = {
  readonly onUncaughtError: (cause: unknown, info: ReactErrorInfo) => void;
  readonly onCaughtError: (cause: unknown, info: ReactErrorInfo) => void;
  readonly onRecoverableError: (cause: unknown, info: ReactErrorInfo) => void;
};

export type BrowserObservabilityReport = {
  readonly recorded: number;
  readonly deduplicated: number;
  readonly suppressed: number;
  readonly failed: number;
  readonly pendingEvents: number;
  readonly deliveryDropped: number;
  readonly sentry: SentryDefectReport;
};

export type BrowserLifecycleReport = {
  readonly durationMillis: number;
  readonly degraded: boolean;
};

export type BrowserObservability = {
  readonly installed: boolean;
  readonly service: BrowserServiceIdentity;
  readonly events: BrowserTelemetryClient;
  readonly defects: { readonly report: (input: DefectReportInput) => DefectOutcome };
  readonly reactRootOptions: ReactRootErrorOptions;
  readonly reports: () => BrowserObservabilityReport;
  readonly flush: () => Promise<void>;
  readonly dispose: () => Promise<BrowserLifecycleReport>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
};

export class BrowserObservabilityError extends Schema.TaggedError<BrowserObservabilityError>()(
  "BrowserObservabilityError",
  {
    code: Schema.Literals([
      "OBS_REACT_CONFIG_INVALID",
      "OBS_REACT_ALREADY_INSTALLED",
      "OBS_REACT_CANARY_ENDPOINT_INVALID",
      "OBS_REACT_CANARY_FAILED",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const activeHosts = (): WeakSet<object> => {
  const key = Symbol.for("@equipe-tech/observability-react/active-hosts");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor !== undefined) {
    try {
      return Schema.decodeUnknownSync(Schema.instanceOf(WeakSet))(descriptor.value);
    } catch {
      const hosts = new WeakSet<object>();
      Object.defineProperty(globalThis, key, {
        configurable: false,
        enumerable: false,
        value: hosts,
        writable: false,
      });
      return hosts;
    }
  }
  const hosts = new WeakSet<object>();
  Object.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: false,
    value: hosts,
    writable: false,
  });
  return hosts;
};
const componentStackLimit = 4_096;

const nativeHost = (): { readonly host: BrowserEventHost; readonly owner: object } | undefined => {
  if (
    !Predicate.hasProperty(globalThis, "addEventListener") ||
    !Predicate.isFunction(globalThis.addEventListener) ||
    !Predicate.hasProperty(globalThis, "removeEventListener") ||
    !Predicate.isFunction(globalThis.removeEventListener)
  ) {
    return undefined;
  }
  return {
    owner: globalThis,
    host: {
      addEventListener: (name, listener) => globalThis.addEventListener(name, listener),
      removeEventListener: (name, listener) => globalThis.removeEventListener(name, listener),
    },
  };
};

const errorFrom = (cause: unknown): Error | undefined => {
  try {
    if (cause instanceof Error) return cause;
    const value = Schema.decodeUnknownOption(
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
    )(cause);
    return new Error(
      Option.isSome(value)
        ? String(value.value).slice(0, 1_024)
        : "An unhandled browser value could not be decoded.",
    );
  } catch {
    return undefined;
  }
};

const eventCause = (event: Event, property: "error" | "reason"): Error | undefined => {
  if (!Predicate.hasProperty(event, property)) return new Error(`Browser ${property} event`);
  return errorFrom(event[property]);
};

const inertHandle = (service: BrowserServiceIdentity): BrowserObservability => {
  const events = createBrowserTelemetryClient({ disabled: true });
  const report = (): DefectOutcome => ({ kind: "suppressed", reason: "not-installed" });
  const lifecycle = Promise.resolve({ durationMillis: 0, degraded: false });
  return {
    installed: false,
    service,
    events,
    defects: { report },
    reactRootOptions: {
      onUncaughtError: () => undefined,
      onCaughtError: () => undefined,
      onRecoverableError: () => undefined,
    },
    reports: () => ({
      recorded: 0,
      deduplicated: 0,
      suppressed: 0,
      failed: 0,
      pendingEvents: 0,
      deliveryDropped: 0,
      sentry: {
        total: 0,
        firstOutcomeAt: Option.none(),
        lastOutcomeAt: Option.none(),
        reasons: {
          disabled: 0,
          policy: 0,
          identity: 0,
          fingerprint: 0,
          captured: 0,
          closed: 0,
          transport: 0,
          flushIncomplete: 0,
        },
      },
    }),
    flush: () => Promise.resolve(),
    dispose: () => lifecycle,
    [Symbol.asyncDispose]: () => lifecycle.then(() => undefined),
  };
};

const eventId = (): string => crypto.randomUUID().replaceAll("-", "");

const invalidConfig = (cause: unknown): never => {
  throw new BrowserObservabilityError({
    code: "OBS_REACT_CONFIG_INVALID",
    message:
      "The React browser observability configuration requires canonical identity, a compilable policy, valid positive options, and a usable browser event host.",
    cause,
  });
};

const validPositiveOption = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value > 0);

type PreparedBrowserEventConfig = {
  endpoint?: string;
  maxBatchSize?: number;
  maxQueueSize?: number;
  flushIntervalMs?: number;
  transport?: BrowserTelemetryClientTransport;
};

type PreparedBrowserSentryConfig = {
  dsn?: string;
  disabled?: boolean;
  componentStack?: boolean;
};

type PreparedBrowserObservabilityConfig = {
  readonly service: BrowserServiceIdentity;
  readonly identity: ResourceIdentity;
  readonly policy: DataPolicy;
  readonly events: PreparedBrowserEventConfig;
  readonly sentry: PreparedBrowserSentryConfig;
  readonly dedupeWindowMillis: number | undefined;
  readonly dedupeCapacity: number | undefined;
  readonly selected: { readonly host: BrowserEventHost; readonly owner: object } | undefined;
};

const prepareConfig = (config: BrowserObservabilityConfig): PreparedBrowserObservabilityConfig => {
  try {
    const serviceInput = config.service;
    const service = {
      name: serviceInput.name,
      version: serviceInput.version,
      environment: serviceInput.environment,
    };
    const policyInput = config.policy;
    const eventInput = config.events;
    const endpoint = eventInput?.endpoint;
    const maxBatchSize = eventInput?.maxBatchSize;
    const maxQueueSize = eventInput?.maxQueueSize;
    const flushIntervalMs = eventInput?.flushIntervalMs;
    const transport = eventInput?.transport;
    const events: PreparedBrowserEventConfig = {};
    if (endpoint !== undefined) events.endpoint = endpoint;
    if (maxBatchSize !== undefined) events.maxBatchSize = maxBatchSize;
    if (maxQueueSize !== undefined) events.maxQueueSize = maxQueueSize;
    if (flushIntervalMs !== undefined) events.flushIntervalMs = flushIntervalMs;
    if (transport !== undefined) events.transport = transport;
    const sentryInput = config.sentry;
    const dsn = sentryInput?.dsn;
    const disabled = sentryInput?.disabled;
    const componentStack = sentryInput?.componentStack;
    const sentry: PreparedBrowserSentryConfig = {};
    if (dsn !== undefined) sentry.dsn = dsn;
    if (disabled !== undefined) sentry.disabled = disabled;
    if (componentStack !== undefined) sentry.componentStack = componentStack;
    const dedupeWindowMillis = config.dedupeWindowMillis;
    const dedupeCapacity = config.dedupeCapacity;
    const hostInput = config.host;
    let selected: PreparedBrowserObservabilityConfig["selected"];
    if (hostInput === undefined) {
      selected = nativeHost();
    } else {
      const addEventListener = hostInput.addEventListener;
      const removeEventListener = hostInput.removeEventListener;
      if (!Predicate.isFunction(addEventListener) || !Predicate.isFunction(removeEventListener)) {
        return invalidConfig("invalid browser event host");
      }
      selected = {
        owner: hostInput,
        host: {
          addEventListener: (name, listener) => addEventListener.call(hostInput, name, listener),
          removeEventListener: (name, listener) =>
            removeEventListener.call(hostInput, name, listener),
        },
      };
    }
    if (
      !validPositiveOption(dedupeWindowMillis) ||
      !validPositiveOption(dedupeCapacity) ||
      !validPositiveOption(events.maxBatchSize) ||
      !validPositiveOption(events.maxQueueSize) ||
      !validPositiveOption(events.flushIntervalMs) ||
      (events.endpoint !== undefined && !Predicate.isString(events.endpoint)) ||
      (events.transport !== undefined && !Predicate.isFunction(events.transport)) ||
      (sentry.dsn !== undefined && !Predicate.isString(sentry.dsn)) ||
      (sentry.disabled !== undefined && !Predicate.isBoolean(sentry.disabled)) ||
      (sentry.componentStack !== undefined && !Predicate.isBoolean(sentry.componentStack))
    ) {
      return invalidConfig("invalid React browser observability options");
    }
    const identity = Effect.runSync(
      parseResourceIdentity({
        serviceName: service.name,
        serviceVersion: service.version,
        environment: service.environment,
      }),
    );
    const policy = Effect.runSync(parseDataPolicy(policyInput));
    let dsnUrl: URL | undefined;
    if (sentry.dsn !== undefined) {
      dsnUrl = Schema.decodeUnknownSync(Schema.URLFromString)(sentry.dsn);
      Effect.runSync(parseSentryDsn(dsnUrl));
    }
    if (
      service.environment === reactWebLifecycle.environmentRequiringDefects &&
      (sentry.dsn === undefined || sentry.disabled === true || dsnUrl?.protocol !== "https:")
    ) {
      return invalidConfig("production browser observability requires an HTTPS Sentry DSN");
    }
    return {
      service,
      identity,
      policy,
      events,
      sentry,
      dedupeWindowMillis,
      dedupeCapacity,
      selected,
    };
  } catch (cause) {
    return invalidConfig(cause);
  }
};

export const createBrowserObservability = (
  config: BrowserObservabilityConfig,
): BrowserObservability => {
  const prepared = prepareConfig(config);
  const {
    service,
    identity,
    policy,
    events: eventConfig,
    sentry: sentryInput,
    selected,
  } = prepared;
  if (selected === undefined) return inertHandle(service);
  let dedupe: ReturnType<typeof defectDeduplicator>;
  let hosts: WeakSet<object>;
  try {
    dedupe = defectDeduplicator(
      prepared.dedupeWindowMillis ?? 60_000,
      prepared.dedupeCapacity ?? 256,
    );
    hosts = activeHosts();
  } catch (cause) {
    return invalidConfig(cause);
  }
  if (hosts.has(selected.owner)) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_ALREADY_INSTALLED",
      message:
        "Browser observability is already installed on this host. Create one runtime beside the React root and share it through application context.",
      cause: "active browser observability host",
    });
  }
  hosts.add(selected.owner);
  let createdEvents: BrowserTelemetryClient | undefined;
  let createdSentry: BrowserSentryDefectReporter | undefined;
  const cleanupConstruction = (
    listeners: ReadonlyArray<readonly [string, (event: Event) => void]> = [],
  ): void => {
    for (const [name, listener] of [...listeners].reverse()) {
      try {
        selected.host.removeEventListener(name, listener);
      } catch {}
    }
    try {
      const sentryToDispose = createdSentry;
      if (sentryToDispose !== undefined) {
        const cleanup = sentryToDispose.dispose();
        Effect.runFork(Effect.promise(() => cleanup));
      }
    } catch {}
    try {
      const eventsToDispose = createdEvents;
      if (eventsToDispose !== undefined) {
        const cleanup = eventsToDispose.dispose();
        Effect.runFork(Effect.promise(() => cleanup));
      }
    } catch {}
    hosts.delete(selected.owner);
  };
  const sentryConfig: Omit<BrowserSentryDefectReporterConfig, "dsn"> = {
    disabled: sentryInput.disabled ?? sentryInput.dsn === undefined,
    service: {
      name: identity.serviceName,
      version: identity.serviceVersion,
      environment: identity.environment,
    },
    policyOwnership: "delegated",
    closeDeadlineMillis: reactWebLifecycle.sentryDeadlineMillis,
    flushDeadlineMillis: reactWebLifecycle.sentryDeadlineMillis,
    deduplication: "delegated",
  };
  try {
    createdEvents = createBrowserTelemetryClient({
      ...eventConfig,
      policy: (fields) => transformSignalFields(policy, "browser-ingest", fields).value,
      shutdownTimeoutMs: reactWebLifecycle.eventShutdownDeadlineMillis,
    });
    createdSentry = createBrowserSentryDefectReporter(
      sentryInput.dsn === undefined ? sentryConfig : { ...sentryConfig, dsn: sentryInput.dsn },
    );
  } catch (cause) {
    cleanupConstruction();
    return invalidConfig(cause);
  }
  if (createdEvents === undefined || createdSentry === undefined) {
    cleanupConstruction();
    return invalidConfig("browser observability clients were not created");
  }
  const events = createdEvents;
  const sentry = createdSentry;
  let closed = false;
  let recorded = 0;
  let deduplicated = 0;
  let suppressed = 0;
  let failed = 0;
  let disposal: Promise<BrowserLifecycleReport> | undefined;
  const defectEnvelopes = new WeakMap<Error, ReturnType<typeof unexpectedDefect>>();

  const report = (input: DefectReportInput): DefectOutcome => {
    let admittedId: string | undefined;
    let sentryDestination: DefectDestinationState["sentry"] = "not-attempted";
    let eventsAttempted = false;
    try {
      if (closed) {
        suppressed += 1;
        return { kind: "suppressed", reason: "closed" };
      }
      const context = new Map<string, string>();
      if (sentryInput.componentStack === true && input.componentStack !== undefined) {
        context.set("react.component_stack", input.componentStack.slice(0, componentStackLimit));
      }
      const previousEnvelope = defectEnvelopes.get(input.error);
      const envelope =
        previousEnvelope ??
        unexpectedDefect({
          error: input.error,
          code: input.code ?? input.origin,
          fingerprint: [input.code ?? input.error.name, input.error.name, input.error.message],
          context,
        });
      defectEnvelopes.set(input.error, envelope);
      const reservedId = eventId();
      const admission = dedupe.admit(reservedId, envelope, Date.now());
      if (admission.kind === "deduplicated") {
        deduplicated += 1;
        return admission;
      }
      admittedId = reservedId;
      const policyDecision = sanitizeDefectEnvelope(policy, envelope);
      if (Option.isNone(policyDecision.value)) {
        dedupe.rollback(reservedId);
        suppressed += 1;
        return { kind: "suppressed", reason: "policy" };
      }
      const sentryOutcome = sentry.capture({ envelope: policyDecision.value.value });
      if (
        sentryOutcome.kind === "deduplicated" ||
        (sentryOutcome.kind === "suppressed" && sentryOutcome.reason === "closed")
      ) {
        dedupe.release(reservedId);
        admittedId = undefined;
        failed += 1;
        return {
          kind: "failed",
          destinations: { sentry: "failed", events: "not-attempted" },
        };
      }
      const sharedId = sentryOutcome.kind === "queued" ? sentryOutcome.eventId : reservedId;
      sentryDestination =
        sentryOutcome.kind === "queued"
          ? "queued"
          : sentryOutcome.kind === "suppressed" && sentryOutcome.reason === "disabled"
            ? "disabled"
            : "failed";
      eventsAttempted = true;
      events.emitDefect({
        id: sharedId,
        name: "browser.error",
        error: {
          type: policyDecision.value.value.fingerprint[1] ?? "Error",
          message: policyDecision.value.value.errorMessage,
          retryable: false,
        },
        fields: { "error.origin": input.origin },
      });
      dedupe.release(reservedId);
      admittedId = undefined;
      recorded += 1;
      return {
        kind: "recorded",
        eventId: sharedId,
        destinations: { sentry: sentryDestination, events: "queued" },
      };
    } catch {
      if (admittedId !== undefined) dedupe.release(admittedId);
      failed += 1;
      return {
        kind: "failed",
        destinations: {
          sentry: sentryDestination,
          events: eventsAttempted ? "failed" : "not-attempted",
        },
      };
    }
  };

  const safeReport = (cause: unknown, origin: DefectOrigin, info?: ReactErrorInfo): void => {
    try {
      const error = errorFrom(cause);
      if (error === undefined) {
        failed += 1;
        return;
      }
      const input = { error, origin };
      const componentStack = info?.componentStack;
      report(componentStack === undefined ? input : { ...input, componentStack });
    } catch {
      failed += 1;
    }
  };
  const onError = (event: Event): void => {
    try {
      const cause = eventCause(event, "error");
      if (cause === undefined) {
        failed += 1;
        return;
      }
      safeReport(cause, "window.error");
    } catch {
      failed += 1;
    }
  };
  const onUnhandledRejection = (event: Event): void => {
    try {
      const cause = eventCause(event, "reason");
      if (cause === undefined) {
        failed += 1;
        return;
      }
      safeReport(cause, "unhandled.rejection");
    } catch {
      failed += 1;
    }
  };
  const initiatePageHideFlush = (delivery: () => Promise<boolean | void>): void => {
    try {
      delivery().catch(() => {
        failed += 1;
      });
    } catch {
      failed += 1;
    }
  };
  const onPageHide = (): void => {
    initiatePageHideFlush(() => events.flush());
    initiatePageHideFlush(() => sentry.flush());
  };
  const installedListeners: Array<readonly [string, (event: Event) => void]> = [];
  try {
    for (const listener of [
      ["error", onError],
      ["unhandledrejection", onUnhandledRejection],
      ["pagehide", onPageHide],
    ] satisfies ReadonlyArray<readonly [string, (event: Event) => void]>) {
      installedListeners.push(listener);
      selected.host.addEventListener(listener[0], listener[1]);
    }
  } catch (cause) {
    cleanupConstruction(installedListeners);
    return invalidConfig(cause);
  }

  let flushInFlight: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (flushInFlight !== undefined) return flushInFlight;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deliveries = Promise.allSettled([
      Promise.resolve().then(() => events.flush()),
      Promise.resolve().then(() => sentry.flush()),
    ]).then(() => undefined);
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        failed += 1;
        resolve();
      }, reactWebLifecycle.flushDeadlineMillis);
    });
    flushInFlight = Promise.race([deliveries, deadline]).finally(() => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      flushInFlight = undefined;
    });
    return flushInFlight;
  };
  const dispose = (): Promise<BrowserLifecycleReport> => {
    if (disposal !== undefined) return disposal;
    const startedAt = Date.now();
    closed = true;
    let teardownFailed = false;
    for (const [name, listener] of [
      ["error", onError],
      ["unhandledrejection", onUnhandledRejection],
      ["pagehide", onPageHide],
    ] satisfies ReadonlyArray<readonly [string, (event: Event) => void]>) {
      try {
        selected.host.removeEventListener(name, listener);
      } catch {
        teardownFailed = true;
        failed += 1;
      }
    }
    hosts.delete(selected.owner);
    disposal = Promise.allSettled([
      Promise.resolve().then(() => events.dispose()),
      Promise.resolve().then(() => sentry.dispose()),
    ]).then((outcomes) => ({
      durationMillis: Date.now() - startedAt,
      degraded:
        teardownFailed ||
        outcomes.some((outcome) => outcome.status === "rejected") ||
        (outcomes[1]?.status === "fulfilled" && outcomes[1].value === false),
    }));
    return disposal;
  };

  return {
    installed: true,
    service,
    events,
    defects: { report },
    reactRootOptions: {
      onUncaughtError: (cause, info) => safeReport(cause, "react.uncaught", info),
      onCaughtError: (cause, info) => safeReport(cause, "react.caught", info),
      onRecoverableError: (cause, info) => safeReport(cause, "react.recoverable", info),
    },
    reports: () => ({
      recorded,
      deduplicated,
      suppressed,
      failed,
      pendingEvents: events.pending(),
      deliveryDropped: events.dropped(),
      sentry: sentry.reports(),
    }),
    flush,
    dispose,
    [Symbol.asyncDispose]: () => dispose().then(() => undefined),
  };
};

export type BrowserDeliveryCanaryTransport = (
  endpoint: URL,
  signal: AbortSignal,
) => Promise<Response>;

export type BrowserDeliveryCanaryInput = {
  readonly endpoint: URL;
  readonly topology?: "published" | "local";
  readonly transport?: BrowserDeliveryCanaryTransport;
};

export type BrowserDeliveryCanaryReceipt = {
  readonly endpointOrigin: string;
  readonly status: 202;
  readonly durationMillis: number;
};

const normalizedHostname = (hostname: string): string => hostname.replace(/\.+$/, "").toLowerCase();

const isLocalDomain = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "local" ||
  hostname.endsWith(".local");

const parseIpv4Address = (hostname: string): ReadonlyArray<number> | undefined => {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) =>
        !Number.isInteger(octet) || !Number.isSafeInteger(octet) || octet < 0 || octet > 255,
    )
  ) {
    return undefined;
  }
  return octets;
};

const isLocalIpv4 = (octets: ReadonlyArray<number>): boolean => {
  const first = octets[0];
  const second = octets[1];
  return (
    (first === 0 && octets.slice(1).every((octet) => octet === 0)) ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const isGloballyRoutableIpv4 = (octets: ReadonlyArray<number>): boolean => {
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  if (first === undefined || second === undefined || third === undefined) return false;
  return !(
    first === 0 ||
    isLocalIpv4(octets) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 31 && third === 196) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 175 && third === 48) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
};

const parseIpv6Address = (hostname: string): ReadonlyArray<number> | undefined => {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return undefined;
  const halves = hostname.slice(1, -1).split("::");
  if (halves.length > 2) return undefined;
  const leading = halves[0]?.length === 0 ? [] : (halves[0]?.split(":") ?? []);
  const trailing = halves[1]?.length === 0 ? [] : (halves[1]?.split(":") ?? []);
  const omitted = 8 - leading.length - trailing.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return undefined;
  }
  const groups = [...leading, ...Array.from({ length: omitted }, () => "0"), ...trailing];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return undefined;
  }
  return groups.map((group) => Number.parseInt(group, 16));
};

const isLocalIpv6 = (groups: ReadonlyArray<number>): boolean => {
  const first = groups[0];
  if (first === undefined) return false;
  return (
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80
  );
};

const isGloballyRoutableIpv6 = (groups: ReadonlyArray<number>): boolean => {
  const first = groups[0];
  const second = groups[1];
  const third = groups[2];
  if (first === undefined || second === undefined || third === undefined) return false;
  return (
    (first & 0xe000) === 0x2000 &&
    !(first === 0x2001 && second === 0) &&
    !(first === 0x2001 && second === 2 && third === 0) &&
    !(first === 0x2001 && (second & 0xfff0) === 0x10) &&
    !(first === 0x2001 && (second & 0xfff0) === 0x20) &&
    !(first === 0x2001 && second === 0x0db8) &&
    first !== 0x2002 &&
    !(first === 0x3fff && (second & 0xf000) === 0)
  );
};

const isLocalEndpoint = (endpoint: URL): boolean => {
  const hostname = normalizedHostname(endpoint.hostname);
  const ipv4 = parseIpv4Address(hostname);
  if (ipv4 !== undefined) return isLocalIpv4(ipv4);
  const ipv6 = parseIpv6Address(hostname);
  if (ipv6 !== undefined) return isLocalIpv6(ipv6);
  return isLocalDomain(hostname);
};

const isGloballyRoutableEndpoint = (endpoint: URL): boolean => {
  const hostname = normalizedHostname(endpoint.hostname);
  const ipv4 = parseIpv4Address(hostname);
  if (ipv4 !== undefined) return isGloballyRoutableIpv4(ipv4);
  const ipv6 = parseIpv6Address(hostname);
  if (ipv6 !== undefined) return isGloballyRoutableIpv6(ipv6);
  return !hostname.startsWith("[") && !isLocalDomain(hostname);
};

const fetchCanary: BrowserDeliveryCanaryTransport = (endpoint, signal) =>
  fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, events: [] }),
    signal,
  });

export const runBrowserDeliveryCanary = async (
  input: BrowserDeliveryCanaryInput,
): Promise<BrowserDeliveryCanaryReceipt> => {
  const endpoint = input.endpoint;
  const topology = input.topology ?? "published";
  const local = isLocalEndpoint(endpoint);
  const globallyRoutable = isGloballyRoutableEndpoint(endpoint);
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_ENDPOINT_INVALID",
      message: "The browser delivery canary endpoint must not contain credentials.",
      cause: endpoint.href,
    });
  }
  if (
    (topology === "published" && endpoint.protocol !== "https:") ||
    (topology === "local" && endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
  ) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_ENDPOINT_INVALID",
      message:
        topology === "published"
          ? "The published browser delivery canary endpoint must use HTTPS."
          : "The local browser delivery canary endpoint must use HTTP or HTTPS.",
      cause: endpoint.href,
    });
  }
  if ((topology === "published" && !globallyRoutable) || (topology === "local" && !local)) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_ENDPOINT_INVALID",
      message:
        topology === "published"
          ? "The published browser delivery canary endpoint must use a globally routable host."
          : "The local browser delivery canary endpoint must use a loopback or private host.",
      cause: endpoint.href,
    });
  }
  if (topology === "local" && input.transport !== undefined) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CONFIG_INVALID",
      message: "The local browser delivery canary does not allow a custom transport.",
      cause: endpoint.href,
    });
  }
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await (input.transport ?? fetchCanary)(endpoint, signal);
  } catch (cause) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_FAILED",
      message: signal.aborted
        ? "The browser delivery canary timed out after five seconds."
        : "The browser delivery canary transport failed before receiving a response.",
      cause,
    });
  }
  if (response.status !== 202) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_FAILED",
      message: `The browser delivery canary expected HTTP 202 and received ${response.status}.`,
      cause: response.status,
    });
  }
  return {
    endpointOrigin: endpoint.origin,
    status: 202,
    durationMillis: Date.now() - startedAt,
  };
};
