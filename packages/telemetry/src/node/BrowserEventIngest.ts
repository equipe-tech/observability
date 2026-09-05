import { Effect, flow, Schema } from "effect";
import { BrowserEventBatch } from "../BrowserEvents.ts";
import { parseResourceIdentity } from "../ResourceIdentity.ts";
import { BrowserSignalExporter } from "../trace/HttpServerOtlpTracer.ts";
import { TelemetryEventSink } from "../contract/EventProducer.ts";
import { CurrentDataPolicy } from "../policy/DataPolicy.ts";
import { transformSignalFields } from "../policy/PolicyTransform.ts";

export class InvalidBrowserEventBatch extends Schema.TaggedError<InvalidBrowserEventBatch>()(
  "InvalidBrowserEventBatch",
  {
    code: Schema.Literal("OBS_BROWSER_EVENTS_INVALID_BATCH"),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeBrowserEventBatch = Schema.decodeUnknownEffect(BrowserEventBatch);

export const parseBrowserEventBatch = flow(
  decodeBrowserEventBatch,
  Effect.mapError(
    (cause) =>
      new InvalidBrowserEventBatch({
        code: "OBS_BROWSER_EVENTS_INVALID_BATCH",
        message:
          "The browser event batch is invalid. Send a version 1 batch with bounded events and scalar fields.",
        cause,
      }),
  ),
);

export type BrowserEventIngestReceipt = {
  readonly accepted: number;
  readonly redacted: number;
  readonly dropped: number;
  readonly spans?: number;
  readonly metrics?: number;
};

const invalidSignalBatch = (cause: string): InvalidBrowserEventBatch =>
  new InvalidBrowserEventBatch({
    code: "OBS_BROWSER_EVENTS_INVALID_BATCH",
    message:
      "The browser event batch has invalid signal correlation. Send completed spans with valid parent and event references in the same trace.",
    cause,
  });

export const ingestBrowserEventBatch = Effect.fn("ingestBrowserEventBatch")(function* (
  batch: BrowserEventBatch,
) {
  const policy = yield* CurrentDataPolicy;
  const sink = yield* TelemetryEventSink;
  const signalExporter = yield* BrowserSignalExporter;
  const spans = batch.spans ?? [];
  const metrics = batch.metrics ?? [];
  const resource =
    batch.resource === undefined
      ? undefined
      : yield* parseResourceIdentity(batch.resource).pipe(
          Effect.mapError(() => invalidSignalBatch("invalid browser resource identity")),
        );
  const spanById = new Map(spans.map((span) => [span.spanId, span]));
  if (spanById.size !== spans.length) return yield* invalidSignalBatch("duplicate span id");
  for (const span of spans) {
    if (span.endedAt < span.startedAt) return yield* invalidSignalBatch("span ended before start");
    if (span.parentSpanId !== undefined) {
      const parent = spanById.get(span.parentSpanId);
      if (
        parent === undefined ||
        parent.traceId !== span.traceId ||
        parent.spanId === span.spanId
      ) {
        return yield* invalidSignalBatch("invalid span parent");
      }
    }
  }
  for (const span of spans) {
    const ancestors = new Set<string>([span.spanId]);
    let parentId = span.parentSpanId;
    while (parentId !== undefined) {
      if (ancestors.has(parentId)) return yield* invalidSignalBatch("cyclic span parent");
      ancestors.add(parentId);
      parentId = spanById.get(parentId)?.parentSpanId;
    }
  }
  for (const event of batch.events) {
    if (event.trace !== undefined) {
      const span = spanById.get(event.trace.spanId);
      if (span === undefined || span.traceId !== event.trace.traceId) {
        return yield* invalidSignalBatch("invalid event trace reference");
      }
    }
  }
  let redacted = 0;
  let dropped = 0;
  const events = batch.events.map((event) => {
    const decision = transformSignalFields(policy, "browser-ingest", event.fields);
    const errorDecision =
      event.error === undefined
        ? undefined
        : transformSignalFields(policy, "browser-ingest", {
            "error.type": event.error.type,
            "error.message": event.error.message,
          });
    const eventDropped = decision.dropped + (errorDecision?.dropped ?? 0);
    dropped += eventDropped;
    redacted += [...decision.redactions, ...(errorDecision?.redactions ?? [])].filter(
      (redaction) => redaction.action !== "dropped",
    ).length;
    const ingested = {
      id: event.id,
      name: event.name,
      occurredAt: event.occurredAt,
      attributes: decision.value,
      admission: { policyDroppedAttributes: eventDropped },
    };
    if (event.trace !== undefined) Object.assign(ingested, { trace: event.trace });
    if (event.error === undefined || errorDecision === undefined) return ingested;
    return {
      ...ingested,
      error: {
        type: String(errorDecision.value["error.type"] ?? "Error"),
        message: String(errorDecision.value["error.message"] ?? ""),
        retryable: event.error.retryable,
      },
    };
  });
  yield* sink.recordBrowserBatch(events);
  const signals = { spans, metrics };
  yield* signalExporter.export(
    resource === undefined
      ? signals
      : {
          ...signals,
          resource: {
            serviceName: resource.serviceName,
            serviceVersion: resource.serviceVersion,
            environment: resource.environment,
          },
        },
  );
  const receipt: BrowserEventIngestReceipt = { accepted: events.length, redacted, dropped };
  if (batch.spans !== undefined) Object.assign(receipt, { spans: spans.length });
  if (batch.metrics !== undefined) Object.assign(receipt, { metrics: metrics.length });
  return receipt;
});

export const ingestBrowserEvents = flow(
  parseBrowserEventBatch,
  Effect.flatMap(ingestBrowserEventBatch),
);
