import { Cause, Context, Duration, Effect, Layer, Option, Predicate, Schema, Tracer } from "effect";
import type { Exit } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpResource, OtlpSerialization } from "effect/unstable/observability";
import type { BrowserTraceSpan } from "../BrowserEvents.ts";
import type { ResourceAttributes } from "../ResourceIdentity.ts";
import type { DataPolicy } from "../policy/DataPolicy.ts";
import { sanitizeText, transformSignalFields } from "../policy/PolicyTransform.ts";
import { effectDroppedAttributesKey } from "../policy/PolicyVocabulary.ts";

const HttpStatusCode = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 100, maximum: 599 }),
);
const decodeHttpStatusCode = Schema.decodeUnknownOption(HttpStatusCode);
const SpanScalar = Schema.Union([
  Schema.String,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
]);
const decodeSpanScalar = Schema.decodeUnknownOption(SpanScalar);

const maxSpanEvents = 128;
const maxSpanLinks = 128;

type SanitizedEntries = {
  readonly attributes: Array<OtlpResource.KeyValue>;
  readonly dropped: number;
};

const sanitizeEntries = (
  policy: DataPolicy,
  fields: { readonly [key: string]: string | number | boolean },
  unsupported = 0,
): SanitizedEntries => {
  const decision = transformSignalFields(policy, "span", fields);
  return {
    attributes: OtlpResource.entriesToAttributes(Object.entries(decision.value)),
    dropped: decision.dropped + unsupported,
  };
};

const scalarFields = (
  entries: Iterable<readonly [string, unknown]>,
  canonicalizeEffectKeys = false,
) => {
  const fields: { [key: string]: string | number | boolean } = {};
  let unsupported = 0;
  for (const [key, value] of entries) {
    const decoded = decodeSpanScalar(value);
    if (key === effectDroppedAttributesKey && Option.isSome(decoded)) {
      if (Predicate.isNumber(decoded.value)) unsupported += decoded.value;
      continue;
    }
    if (Option.isNone(decoded)) {
      unsupported += 1;
      continue;
    }
    const canonicalKey = canonicalizeEffectKeys
      ? key === "effect.fiberId"
        ? "effect.fiber.id"
        : key === "effect.logLevel"
          ? "effect.log.level"
          : key
      : key;
    fields[canonicalKey] = decoded.value;
  }
  return { fields, unsupported };
};

const statusCodeUnset = 0;
const statusCodeOk = 1;
const statusCodeError = 2;

const spanKindCode = (kind: Tracer.SpanKind): number => {
  switch (kind) {
    case "internal":
      return 1;
    case "server":
      return 2;
    case "client":
      return 3;
    case "producer":
      return 4;
    case "consumer":
      return 5;
  }
};

type HttpTracerSpanOptions = {
  readonly name: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly startTime: bigint;
  readonly kind: Tracer.SpanKind;
  readonly sampled: boolean;
};

type OtlpStatus = {
  readonly code: number;
  readonly message?: string | undefined;
};

type OtlpEvent = {
  readonly attributes: Array<OtlpResource.KeyValue>;
  readonly name: string;
  readonly timeUnixNano: string;
  readonly droppedAttributesCount: number;
};

type OtlpLink = {
  readonly attributes: Array<OtlpResource.KeyValue>;
  readonly spanId: string;
  readonly traceId: string;
  readonly droppedAttributesCount: number;
};

type OtlpSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: Array<OtlpResource.KeyValue>;
  readonly droppedAttributesCount: number;
  readonly events: Array<OtlpEvent>;
  readonly droppedEventsCount: number;
  readonly status: OtlpStatus;
  readonly links: Array<OtlpLink>;
  readonly droppedLinksCount: number;
};

class ExportingSpan extends Tracer.NativeSpan {
  readonly #exportSpan: (span: ExportingSpan) => void;
  #ended = false;

  constructor(options: HttpTracerSpanOptions, exportSpan: (span: ExportingSpan) => void) {
    super(options);
    this.#exportSpan = exportSpan;
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.#ended) return;
    this.#ended = true;
    super.end(endTime, exit);
    if (this.sampled) this.#exportSpan(this);
  }
}

const makeEvents = (policy: DataPolicy, span: ExportingSpan): Array<OtlpEvent> =>
  span.events.map(([name, startTime, attributes]) => {
    const canonicalizeEffectKeys =
      Object.hasOwn(attributes, "effect.fiberId") && Object.hasOwn(attributes, "effect.logLevel");
    const input = scalarFields(Object.entries(attributes), canonicalizeEffectKeys);
    const decision = sanitizeEntries(policy, input.fields, input.unsupported);
    return {
      name: sanitizeText(policy, name, "span"),
      timeUnixNano: String(startTime),
      attributes: decision.attributes,
      droppedAttributesCount: decision.dropped,
    };
  });

type NonHttpStatus = {
  readonly status: OtlpStatus;
  readonly attributes: ReadonlyArray<readonly [string, string | boolean]>;
  readonly events: ReadonlyArray<OtlpEvent>;
};

const makeNonHttpStatus = (policy: DataPolicy, span: ExportingSpan): NonHttpStatus => {
  if (span.status._tag !== "Ended") {
    return { status: { code: statusCodeUnset }, attributes: [], events: [] };
  }
  if (span.status.exit._tag === "Success") {
    return { status: { code: statusCodeOk }, attributes: [], events: [] };
  }
  if (Cause.hasInterruptsOnly(span.status.exit.cause)) {
    return {
      status: { code: statusCodeOk, message: "Interrupted" },
      attributes: [
        ["span.label", "⚠︎ Interrupted"],
        ["status.interrupted", true],
      ],
      events: [],
    };
  }
  const errors = Cause.prettyErrors(span.status.exit.cause, { includeCauseInStack: true });
  const endTime = span.status.endTime;
  const events = errors.map((error): OtlpEvent => {
    const decision = sanitizeEntries(policy, {
      "exception.type": error.name,
      "exception.message": error.message,
      "exception.stacktrace": error.stack ?? "No stack trace available",
    });
    return {
      name: "exception",
      timeUnixNano: String(endTime),
      attributes: decision.attributes,
      droppedAttributesCount: decision.dropped,
    };
  });
  return {
    status:
      errors.length === 0
        ? { code: statusCodeError }
        : {
            code: statusCodeError,
            message: sanitizeText(policy, errors[0]?.message ?? "Error", "span"),
          },
    attributes: [],
    events,
  };
};

const makeHttpStatus = (span: ExportingSpan): OtlpStatus => {
  if (span.attributes.has("error.type")) return { code: statusCodeError };
  return decodeHttpStatusCode(span.attributes.get("http.response.status_code")).pipe(
    Option.match({
      onNone: () => ({ code: statusCodeUnset }),
      onSome: (status) => ({ code: status >= 500 ? statusCodeError : statusCodeUnset }),
    }),
  );
};

const makeOtlpSpan = (policy: DataPolicy, span: ExportingSpan): Option.Option<OtlpSpan> => {
  if (span.status._tag !== "Ended") return Option.none();
  const isHttpServer = span.kind === "server" && span.attributes.has("http.request.method");
  const nonHttp = isHttpServer
    ? { status: makeHttpStatus(span), attributes: [], events: [] }
    : makeNonHttpStatus(policy, span);
  const spanInput = scalarFields(span.attributes);
  for (const [key, value] of nonHttp.attributes) spanInput.fields[key] = value;
  const attributeDecision = sanitizeEntries(policy, spanInput.fields, spanInput.unsupported);
  const allEvents = [...makeEvents(policy, span), ...nonHttp.events];
  const events = allEvents.slice(0, maxSpanEvents);
  const allLinks = span.links.map((link): OtlpLink => {
    const input = scalarFields(Object.entries(link.attributes));
    const decision = sanitizeEntries(policy, input.fields, input.unsupported);
    return {
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: decision.attributes,
      droppedAttributesCount: decision.dropped,
    };
  });
  const links = allLinks.slice(0, maxSpanLinks);
  return Option.some({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.getOrUndefined(Option.map(span.parent, (parent) => parent.spanId)),
    name: sanitizeText(policy, span.name, "span"),
    kind: spanKindCode(span.kind),
    startTimeUnixNano: String(span.status.startTime),
    endTimeUnixNano: String(span.status.endTime),
    attributes: attributeDecision.attributes,
    droppedAttributesCount: attributeDecision.dropped,
    events,
    droppedEventsCount: allEvents.length - events.length,
    status: nonHttp.status,
    links,
    droppedLinksCount: allLinks.length - links.length,
  });
};

export type HttpServerOtlpTracerOptions = {
  readonly url: string;
  readonly policy: DataPolicy;
  readonly resource: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly attributes: ResourceAttributes;
  };
  readonly shutdownTimeout?: Duration.Input | undefined;
};

const makeHttpServerOtlpTracer = Effect.fn("makeHttpServerOtlpTracer")(function* (
  options: HttpServerOtlpTracerOptions,
) {
  const resource = yield* OtlpResource.fromConfig(options.resource);
  const serialization = yield* OtlpSerialization.OtlpSerialization;
  const exporter = yield* OtlpExporter.make({
    label: "HttpServerOtlpTracer",
    url: options.url,
    headers: undefined,
    exportInterval: Duration.seconds(5),
    maxBatchSize: 1000,
    body: (spans) => [
      serialization.traces({
        resourceSpans: [
          {
            resource,
            scopeSpans: [
              {
                scope: { name: OtlpResource.serviceNameUnsafe(resource) },
                spans,
              },
            ],
          },
        ],
      }),
      Effect.void,
    ],
    shutdownTimeout: options.shutdownTimeout ?? Duration.seconds(3),
  });
  return Tracer.make({
    span: (spanOptions) =>
      new ExportingSpan(spanOptions, (span) => {
        const exported = makeOtlpSpan(options.policy, span);
        if (Option.isSome(exported)) exporter.push(exported.value);
      }),
  });
});

export const layerHttpServerOtlpTracer = (
  options: HttpServerOtlpTracerOptions,
): Layer.Layer<
  OtlpExporter.Flusher,
  never,
  HttpClient.HttpClient | OtlpSerialization.OtlpSerialization
> =>
  Layer.effect(Tracer.Tracer, makeHttpServerOtlpTracer(options)).pipe(
    Layer.provideMerge(OtlpExporter.layerFlusher),
  );

export type BrowserSignals = {
  readonly resource?: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly environment: string;
  };
  readonly spans: ReadonlyArray<BrowserTraceSpan>;
};

export class BrowserSignalExporter extends Context.Reference(
  "@equipe-tech/observability/BrowserSignalExporter",
  {
    defaultValue: (): { readonly export: (signals: BrowserSignals) => Effect.Effect<void> } => ({
      export: () => Effect.void,
    }),
  },
) {}

type BrowserOtlpSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: 1;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: Array<OtlpResource.KeyValue>;
  readonly droppedAttributesCount: number;
  readonly events: [];
  readonly droppedEventsCount: 0;
  readonly status: { readonly code: 1 };
  readonly links: [];
  readonly droppedLinksCount: 0;
};

type BrowserTraceExport = {
  readonly resource: OtlpResource.Resource;
  readonly span: BrowserOtlpSpan;
};

const unixNanos = (millis: number): string => String(BigInt(Math.trunc(millis)) * 1_000_000n);

const browserResource = (
  base: OtlpResource.Resource,
  policy: DataPolicy,
  identity: BrowserSignals["resource"],
): OtlpResource.Resource => {
  if (identity === undefined) return base;
  const replaced = new Set([
    "service.name",
    "service.version",
    "deployment.environment.name",
    "deployment.environment",
  ]);
  const decision = transformSignalFields(policy, "resource", {
    "service.name": identity.serviceName,
    "service.version": identity.serviceVersion,
    "deployment.environment.name": identity.environment,
    "deployment.environment": identity.environment,
  });
  return {
    attributes: [
      ...base.attributes.filter((attribute) => !replaced.has(attribute.key)),
      ...OtlpResource.entriesToAttributes(Object.entries(decision.value)),
    ],
    droppedAttributesCount: base.droppedAttributesCount + decision.dropped,
  };
};

export type BrowserSignalExporterOptions = {
  readonly tracesUrl: string;
  readonly policy: DataPolicy;
  readonly resource: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly attributes: ResourceAttributes;
  };
  readonly shutdownTimeout?: Duration.Input | undefined;
};

export const layerBrowserSignalExporter = (
  options: BrowserSignalExporterOptions,
): Layer.Layer<
  OtlpExporter.Flusher,
  never,
  HttpClient.HttpClient | OtlpSerialization.OtlpSerialization
> =>
  Layer.effect(
    BrowserSignalExporter,
    Effect.gen(function* () {
      const resource = yield* OtlpResource.fromConfig(options.resource);
      const serialization = yield* OtlpSerialization.OtlpSerialization;
      const traces = yield* OtlpExporter.make({
        label: "BrowserSignalTracer",
        url: options.tracesUrl,
        headers: undefined,
        exportInterval: Duration.seconds(5),
        maxBatchSize: 1_000,
        body: (exports: ReadonlyArray<BrowserTraceExport>) => [
          serialization.traces({
            resourceSpans: exports.map((entry) => ({
              resource: entry.resource,
              scopeSpans: [
                {
                  scope: { name: OtlpResource.serviceNameUnsafe(entry.resource) },
                  spans: [entry.span],
                },
              ],
            })),
          }),
          Effect.void,
        ],
        shutdownTimeout: options.shutdownTimeout ?? Duration.seconds(3),
      });
      return BrowserSignalExporter.of({
        export: (signals) =>
          Effect.sync(() => {
            const selectedResource = browserResource(resource, options.policy, signals.resource);
            for (const span of signals.spans) {
              const decision = transformSignalFields(options.policy, "span", span.fields);
              traces.push({
                resource: selectedResource,
                span: {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  parentSpanId: span.parentSpanId,
                  name: sanitizeText(options.policy, span.name, "span"),
                  kind: 1,
                  startTimeUnixNano: unixNanos(span.startedAt),
                  endTimeUnixNano: unixNanos(span.endedAt),
                  attributes: OtlpResource.entriesToAttributes(Object.entries(decision.value)),
                  droppedAttributesCount: decision.dropped,
                  events: [],
                  droppedEventsCount: 0,
                  status: { code: 1 },
                  links: [],
                  droppedLinksCount: 0,
                },
              });
            }
          }),
      });
    }),
  ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));
