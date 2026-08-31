import { reactWebLifecycle } from "@equipe-tech/observability/react-web-profile";
import {
  createBrowserTelemetryClient,
  type BrowserTelemetryClient,
  type BrowserTelemetryClientConfig,
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
import {
  createBrowserSentryDefectReporter,
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

const activeHostsKey = Symbol.for("@equipe-tech/observability-react/active-hosts");
const activeHosts = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, activeHostsKey);
  if (descriptor !== undefined) {
    try {
      return Schema.decodeUnknownSync(Schema.instanceOf(WeakSet))(descriptor.value);
    } catch {
      Object.defineProperty(globalThis, activeHostsKey, {
        configurable: false,
        value: new WeakSet<object>(),
      });
    }
  }
  const hosts = new WeakSet<object>();
  Object.defineProperty(globalThis, activeHostsKey, { configurable: false, value: hosts });
  return hosts;
})();
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

export const createBrowserObservability = (
  config: BrowserObservabilityConfig,
): BrowserObservability => {
  let identity: ResourceIdentity;
  let policy: DataPolicy;
  try {
    if (
      !validPositiveOption(config.dedupeWindowMillis) ||
      !validPositiveOption(config.dedupeCapacity) ||
      !validPositiveOption(config.events?.maxBatchSize) ||
      !validPositiveOption(config.events?.maxQueueSize) ||
      !validPositiveOption(config.events?.flushIntervalMs) ||
      (config.host !== undefined &&
        (!Predicate.isFunction(config.host.addEventListener) ||
          !Predicate.isFunction(config.host.removeEventListener))) ||
      (config.service.environment === reactWebLifecycle.environmentRequiringDefects &&
        (config.sentry?.dsn === undefined || config.sentry.disabled === true))
    ) {
      return invalidConfig("invalid React browser observability options");
    }
    identity = Effect.runSync(
      parseResourceIdentity({
        serviceName: config.service.name,
        serviceVersion: config.service.version,
        environment: config.service.environment,
      }),
    );
    policy = Effect.runSync(parseDataPolicy(config.policy));
  } catch (cause) {
    return invalidConfig(cause);
  }
  const selected =
    config.host === undefined ? nativeHost() : { host: config.host, owner: config.host };
  if (selected === undefined) return inertHandle(config.service);
  if (activeHosts.has(selected.owner)) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_ALREADY_INSTALLED",
      message:
        "Browser observability is already installed on this host. Create one runtime beside the React root and share it through application context.",
      cause: "active browser observability host",
    });
  }
  activeHosts.add(selected.owner);
  const events = createBrowserTelemetryClient({
    ...config.events,
    policy: (fields) => transformSignalFields(policy, "browser-ingest", fields).value,
    shutdownTimeoutMs: reactWebLifecycle.eventShutdownDeadlineMillis,
  });
  const sentryConfig: Omit<BrowserSentryDefectReporterConfig, "dsn"> = {
    disabled: config.sentry?.disabled ?? config.sentry?.dsn === undefined,
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
  const sentry = createBrowserSentryDefectReporter(
    config.sentry?.dsn === undefined ? sentryConfig : { ...sentryConfig, dsn: config.sentry.dsn },
  );
  const dedupe = defectDeduplicator(
    config.dedupeWindowMillis ?? 60_000,
    config.dedupeCapacity ?? 256,
  );
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
      if (config.sentry?.componentStack === true && input.componentStack !== undefined) {
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
  const onPageHide = (): void => {
    try {
      events.flush().catch(() => {
        failed += 1;
      });
    } catch {
      failed += 1;
    }
  };
  selected.host.addEventListener("error", onError);
  selected.host.addEventListener("unhandledrejection", onUnhandledRejection);
  selected.host.addEventListener("pagehide", onPageHide);

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
    activeHosts.delete(selected.owner);
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
    service: config.service,
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

const localHostnames = new Set(["localhost", "0.0.0.0"]);

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const first = octets[0];
  const second = octets[1];
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const isLocalEndpoint = (endpoint: URL): boolean =>
  localHostnames.has(endpoint.hostname) ||
  endpoint.hostname.endsWith(".localhost") ||
  endpoint.hostname.endsWith(".local") ||
  endpoint.hostname === "[::1]" ||
  endpoint.hostname.startsWith("[fc") ||
  endpoint.hostname.startsWith("[fd") ||
  endpoint.hostname.startsWith("[fe80:") ||
  isPrivateIpv4(endpoint.hostname);

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
  if ((topology === "published" && local) || (topology === "local" && !local)) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_ENDPOINT_INVALID",
      message:
        topology === "published"
          ? "The published browser delivery canary endpoint must use a non-local host."
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
