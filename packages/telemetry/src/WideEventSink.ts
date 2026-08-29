import { Layer, Option } from "effect";
import { TelemetryEventSink } from "./contract/EventProducer.ts";
import type { AttributeValue, TelemetryEvent } from "./contract/TelemetryEvent.ts";
import * as WideEvent from "./WideEvent.ts";

type MutableWideEventFields = {
  [attribute: string]: AttributeValue;
};

const fieldsForEvent = (event: TelemetryEvent): WideEvent.WideEventFields => {
  const fields: MutableWideEventFields = {
    "event.type": event.kind,
    "event.severity": event.severity,
    "event.outcome": event.outcome,
    "event.timestamp": event.timestamp,
  };
  for (const [name, value] of Object.entries(event.attributes)) {
    fields[name] = value;
  }
  if (Option.isSome(event.correlation)) {
    const correlation = event.correlation.value;
    if (Option.isSome(correlation.requestId)) {
      fields["request.id"] = correlation.requestId.value;
    }
    if (Option.isSome(correlation.runId)) {
      fields["run.id"] = correlation.runId.value;
    }
  }
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
      if (event.audit.actor.kind !== "system") {
        fields["audit.actor.id"] = event.audit.actor.id;
      }
      fields["audit.resource.type"] = event.audit.resourceType;
      fields["audit.resource.id"] = event.audit.resourceId;
      break;
  }
  return fields;
};

export const layerWideEvent: Layer.Layer<TelemetryEventSink> = Layer.succeed(
  TelemetryEventSink,
  TelemetryEventSink.of({
    record: (event) => WideEvent.emit(event.name, fieldsForEvent(event)),
  }),
);
