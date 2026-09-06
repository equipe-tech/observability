import { Cause, Duration, Effect, Layer, Option, Schema, Tracer } from "effect";
import type { Exit } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpResource, OtlpSerialization } from "effect/unstable/observability";
import type { ResourceAttributes } from "../ResourceIdentity.ts";

const HttpStatusCode = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 100, maximum: 599 }),
);
const decodeHttpStatusCode = Schema.decodeUnknownOption(HttpStatusCode);

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
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    super.end(endTime, exit);
    if (this.sampled) {
      this.#exportSpan(this);
    }
  }
}

const makeEvents = (span: ExportingSpan): Array<OtlpEvent> =>
  span.events.map(([name, startTime, attributes]) => ({
    name,
    timeUnixNano: String(startTime),
    attributes: OtlpResource.entriesToAttributes(Object.entries(attributes)),
    droppedAttributesCount: 0,
  }));

const makeNonHttpStatus = (
  span: ExportingSpan,
  attributes: Array<OtlpResource.KeyValue>,
  events: Array<OtlpEvent>,
): OtlpStatus => {
  if (span.status._tag !== "Ended") {
    return { code: statusCodeUnset };
  }
  if (span.status.exit._tag === "Success") {
    return { code: statusCodeOk };
  }
  if (Cause.hasInterruptsOnly(span.status.exit.cause)) {
    attributes.push(
      {
        key: "span.label",
        value: { stringValue: "⚠︎ Interrupted" },
      },
      {
        key: "status.interrupted",
        value: { boolValue: true },
      },
    );
    return { code: statusCodeOk, message: "Interrupted" };
  }
  const errors = Cause.prettyErrors(span.status.exit.cause, { includeCauseInStack: true });
  for (const error of errors) {
    events.push({
      name: "exception",
      timeUnixNano: String(span.status.endTime),
      droppedAttributesCount: 0,
      attributes: OtlpResource.entriesToAttributes([
        ["exception.type", error.name],
        ["exception.message", error.message],
        ["exception.stacktrace", error.stack ?? "No stack trace available"],
      ]),
    });
  }
  return errors.length === 0
    ? { code: statusCodeError }
    : { code: statusCodeError, message: errors[0]?.message };
};

const makeHttpStatus = (span: ExportingSpan): OtlpStatus => {
  if (span.attributes.has("error.type")) {
    return { code: statusCodeError };
  }
  return decodeHttpStatusCode(span.attributes.get("http.response.status_code")).pipe(
    Option.match({
      onNone: () => ({ code: statusCodeUnset }),
      onSome: (status) => ({ code: status >= 500 ? statusCodeError : statusCodeUnset }),
    }),
  );
};

const makeOtlpSpan = (span: ExportingSpan): Option.Option<OtlpSpan> => {
  if (span.status._tag !== "Ended") {
    return Option.none();
  }
  const attributes = OtlpResource.entriesToAttributes(span.attributes.entries());
  const events = makeEvents(span);
  const isHttpServer = span.kind === "server" && span.attributes.has("http.request.method");
  return Option.some({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.getOrUndefined(Option.map(span.parent, (parent) => parent.spanId)),
    name: span.name,
    kind: spanKindCode(span.kind),
    startTimeUnixNano: String(span.status.startTime),
    endTimeUnixNano: String(span.status.endTime),
    attributes,
    droppedAttributesCount: 0,
    events,
    droppedEventsCount: 0,
    status: isHttpServer ? makeHttpStatus(span) : makeNonHttpStatus(span, attributes, events),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: OtlpResource.entriesToAttributes(Object.entries(link.attributes)),
      droppedAttributesCount: 0,
    })),
    droppedLinksCount: 0,
  });
};

export type HttpServerOtlpTracerOptions = {
  readonly url: string;
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
        const exported = makeOtlpSpan(span);
        if (Option.isSome(exported)) {
          exporter.push(exported.value);
        }
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
