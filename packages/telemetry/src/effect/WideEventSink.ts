import { Effect, Layer, Option } from "effect";
import { TelemetryEventSink } from "../contract/EventProducer.ts";
import type {
  AttributeValue,
  EventAttributes,
  TelemetryEvent,
} from "../contract/TelemetryEvent.ts";
import * as WideEvent from "./WideEvent.ts";

type MutableEventAttributes = {
  [attribute: string]: AttributeValue;
};

const fieldsForEvent = (event: TelemetryEvent): EventAttributes => {
  const fields: MutableEventAttributes = {
    "event.type": event.kind,
    "event.severity": event.severity,
    "event.outcome": event.outcome,
    "event.timestamp": event.timestamp,
  };
  for (const [name, value] of Object.entries(event.attributes)) {
    fields[name] = value;
  }
  if (Option.isSome(event.correlation.requestId)) {
    fields["request.id"] = event.correlation.requestId.value;
  }
  if (Option.isSome(event.correlation.runId)) {
    fields["run.id"] = event.correlation.runId.value;
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
    record: (event, admission) =>
      WideEvent.emit(event.name, {
        ...fieldsForEvent(event),
        "event.policy_dropped_attributes": admission.policyDroppedAttributes,
      }),
    recordBrowserBatch: (events) =>
      Effect.forEach(
        events,
        (event) => {
          const fields: { [name: string]: string | number | boolean } = {
            ...event.attributes,
            "event.source": "browser",
            "event.outcome": event.error === undefined ? "success" : "failure",
            "browser.event.id": event.id,
            "browser.event.occurred_at": event.occurredAt,
            "event.policy_dropped_attributes": event.admission.policyDroppedAttributes,
          };
          if (event.error !== undefined) {
            fields["error.type"] = event.error.type;
            fields["error.message"] = event.error.message;
            fields["error.retryable"] = event.error.retryable;
          }
          return WideEvent.emit(event.name, fields);
        },
        { discard: true },
      ),
  }),
);
