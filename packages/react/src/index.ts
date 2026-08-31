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
  unexpectedDefect,
  type DataPolicyInput,
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

export type DefectOutcome =
  | {
      readonly kind: "recorded";
      readonly eventId: string;
      readonly destinations: {
        readonly sentry: "queued" | "disabled" | "failed";
        readonly events: "queued";
      };
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

const activeHosts = new WeakSet<object>();
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

const errorFrom = (cause: unknown): Error => {
  if (cause instanceof Error) return cause;
  const value = Schema.decodeUnknownOption(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  )(cause);
  return new Error(
    Option.isSome(value)
      ? String(value.value).slice(0, 1_024)
      : "An unhandled browser value could not be decoded.",
  );
};

const eventCause = (event: Event, property: "error" | "reason"): Error => {
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

export const createBrowserObservability = (
  config: BrowserObservabilityConfig,
): BrowserObservability => {
  const identity = Effect.runSync(
    parseResourceIdentity({
      serviceName: config.service.name,
      serviceVersion: config.service.version,
      environment: config.service.environment,
    }),
  );
  const policy = Effect.runSync(parseDataPolicy(config.policy));
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
    policy: config.policy,
    shutdownTimeoutMs: 1_150,
  });
  const sentryConfig: Omit<BrowserSentryDefectReporterConfig, "dsn"> = {
    disabled: config.sentry?.disabled ?? config.sentry?.dsn === undefined,
    service: {
      name: identity.serviceName,
      version: identity.serviceVersion,
      environment: identity.environment,
    },
    policy: config.policy,
    closeDeadlineMillis: 800,
    flushDeadlineMillis: 800,
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
  let disposal: Promise<BrowserLifecycleReport> | undefined;
  const defectEnvelopes = new WeakMap<Error, ReturnType<typeof unexpectedDefect>>();

  const report = (input: DefectReportInput): DefectOutcome => {
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
      const policyDecision = sanitizeDefectEnvelope(policy, envelope);
      if (Option.isNone(policyDecision.value)) {
        dedupe.rollback(reservedId);
        suppressed += 1;
        return { kind: "suppressed", reason: "policy" };
      }
      const sentryOutcome = sentry.capture({ envelope: policyDecision.value.value });
      const sharedId = sentryOutcome.kind === "queued" ? sentryOutcome.eventId : reservedId;
      const sentryDestination =
        sentryOutcome.kind === "queued"
          ? "queued"
          : sentryOutcome.kind === "suppressed" && sentryOutcome.reason === "disabled"
            ? "disabled"
            : "failed";
      events.emitDefect({
        id: sharedId,
        name: "browser.error",
        error: {
          type: input.error.name || "Error",
          message: policyDecision.value.value.errorMessage,
          retryable: false,
        },
        fields: { "error.origin": input.origin },
      });
      recorded += 1;
      return {
        kind: "recorded",
        eventId: sharedId,
        destinations: { sentry: sentryDestination, events: "queued" },
      };
    } catch {
      suppressed += 1;
      return { kind: "suppressed", reason: closed ? "closed" : "policy" };
    }
  };

  const safeReport = (cause: unknown, origin: DefectOrigin, info?: ReactErrorInfo): void => {
    const input = { error: errorFrom(cause), origin };
    report(
      info?.componentStack === undefined
        ? input
        : { ...input, componentStack: info.componentStack },
    );
  };
  const onError = (event: Event): void => safeReport(eventCause(event, "error"), "window.error");
  const onUnhandledRejection = (event: Event): void =>
    safeReport(eventCause(event, "reason"), "unhandled.rejection");
  const onPageHide = (): void => {
    events.flush().catch(() => undefined);
  };
  selected.host.addEventListener("error", onError);
  selected.host.addEventListener("unhandledrejection", onUnhandledRejection);
  selected.host.addEventListener("pagehide", onPageHide);

  const flush = async (): Promise<void> => {
    await Promise.allSettled([events.flush(), sentry.flush()]);
  };
  const dispose = (): Promise<BrowserLifecycleReport> => {
    if (disposal !== undefined) return disposal;
    const startedAt = Date.now();
    closed = true;
    selected.host.removeEventListener("error", onError);
    selected.host.removeEventListener("unhandledrejection", onUnhandledRejection);
    selected.host.removeEventListener("pagehide", onPageHide);
    activeHosts.delete(selected.owner);
    disposal = Promise.allSettled([events.dispose(), sentry.dispose()]).then((outcomes) => ({
      durationMillis: Date.now() - startedAt,
      degraded:
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
      pendingEvents: events.pending(),
      sentry: sentry.reports(),
    }),
    flush,
    dispose,
    [Symbol.asyncDispose]: () => dispose().then(() => undefined),
  };
};

export type BrowserDeliveryCanaryInput = {
  readonly endpoint: URL;
};

export type BrowserDeliveryCanaryReceipt = {
  readonly endpointOrigin: string;
  readonly status: 202;
  readonly durationMillis: number;
};

const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

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

export const runBrowserDeliveryCanary = async (
  input: BrowserDeliveryCanaryInput,
): Promise<BrowserDeliveryCanaryReceipt> => {
  const endpoint = input.endpoint;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    isLocalEndpoint(endpoint)
  ) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_ENDPOINT_INVALID",
      message:
        "The browser delivery canary requires a credential-free HTTPS URL on a published non-loopback host.",
      cause: endpoint.href,
    });
  }
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, events: [] }),
      signal,
    });
  } catch (cause) {
    throw new BrowserObservabilityError({
      code: "OBS_REACT_CANARY_FAILED",
      message: "The browser delivery canary did not complete within five seconds.",
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
