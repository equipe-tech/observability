import { Effect, Option, Schema } from "effect";
import { EventName, isValidAttributeName, isValidEventName } from "./EventName.ts";
import {
  EventKind,
  EventOutcome,
  EventSeverity,
  type EventKind as EventKindType,
  type EventOutcome as EventOutcomeType,
  type EventSeverity as EventSeverityType,
  type EventAttributes,
} from "./TelemetryEvent.ts";
import {
  InvalidTelemetryContract,
  InvalidTelemetryEvent,
  type ContractIssue,
  type ContractIssueCode,
} from "./TelemetryContractError.ts";
import {
  type CompiledMetricDefinition,
  type MetricDefinitionsInput,
  isValidHistogramBoundaries,
  isValidMetricAttributeCount,
  isValidMetricAttributeName,
  isValidMetricCardinality,
  isValidMetricDescription,
  isValidMetricName,
  isValidMetricUnit,
  validAllowedValues,
} from "./MetricDefinition.ts";
export type {
  CounterMetricDefinitionInput,
  HistogramMetricDefinitionInput,
  MetricAttributeDefinitionInput,
  MetricDefinitionInput,
  MetricDefinitionsInput,
  MetricKind,
  ObservableGaugeMetricDefinitionInput,
} from "./MetricDefinition.ts";
export { defineMetricDefinitions, isValidMetricName } from "./MetricDefinition.ts";

export const AttributeClassification = Schema.Literals([
  "public",
  "internal",
  "sensitive",
  "forbidden",
]);
export type AttributeClassification = typeof AttributeClassification.Type;

export type AttributeDefinition = {
  readonly classification: AttributeClassification;
  readonly required: boolean;
  readonly metricLabel: boolean;
};

export type AttributeDefinitionsInput = {
  readonly [attributeName: string]: AttributeDefinition;
};

export type SamplingPolicyInput =
  | { readonly kind: "always" }
  | { readonly kind: "rate"; readonly rate: number };

export type EventDefinitionInput = {
  readonly name: string;
  readonly kind: EventKindType;
  readonly defaultSeverity: EventSeverityType;
  readonly mandatory: boolean;
  readonly sampling: SamplingPolicyInput;
  readonly attributes: AttributeDefinitionsInput;
};

export type EventDefinitionsInput = {
  readonly [alias: string]: EventDefinitionInput;
};

export const defineEventDefinitions = <const Events extends EventDefinitionsInput>(
  events: Events,
): Events => events;

export type AuditActionDefinitionInput = {
  readonly action: string;
  readonly resourceType: string;
  readonly allowedOutcomes: ReadonlyArray<EventOutcomeType>;
};

export type AuditActionDefinitionsInput = {
  readonly [alias: string]: AuditActionDefinitionInput;
};

export type TelemetryContractInput = {
  readonly version: 1;
  readonly events: EventDefinitionsInput;
  readonly metrics: MetricDefinitionsInput;
  readonly auditActions: AuditActionDefinitionsInput;
};

export const telemetryContractDefinition = <const Definition extends TelemetryContractInput>(
  definition: Definition,
): Definition => definition;

type StaticEventNames<Definition extends TelemetryContractInput> = {
  readonly events: {
    readonly [
      Alias in keyof Definition["events"]
    ]: string extends Definition["events"][Alias]["name"] ? never : Definition["events"][Alias];
  };
};

export type CompiledEventDefinition = {
  readonly alias: string;
  readonly name: EventName;
  readonly kind: EventKindType;
  readonly defaultSeverity: EventSeverityType;
  readonly mandatory: boolean;
  readonly sampling: SamplingPolicyInput;
  readonly attributes: ReadonlyMap<string, AttributeDefinition>;
  readonly requiredAttributes: ReadonlyArray<string>;
};

export type CompiledAuditActionDefinition = AuditActionDefinitionInput & {
  readonly alias: string;
};

export type EventContractRegistry = {
  readonly eventByName: ReadonlyMap<EventName, CompiledEventDefinition>;
};

export const validateContractEvent = (
  contract: EventContractRegistry,
  eventName: string,
  attributes: EventAttributes,
): CompiledEventDefinition | InvalidTelemetryEvent => {
  const parsedEventName = EventName.makeOption(eventName);
  const definition = Option.isSome(parsedEventName)
    ? contract.eventByName.get(parsedEventName.value)
    : undefined;
  if (definition === undefined) {
    return new InvalidTelemetryEvent({
      code: "OBS_EVENT_UNKNOWN_NAME",
      message: `Event "${eventName}" is not declared by the telemetry contract. Use a valid declared canonical event name.`,
      eventName,
    });
  }
  for (const required of definition.requiredAttributes) {
    if (!Object.hasOwn(attributes, required)) {
      return new InvalidTelemetryEvent({
        code: "OBS_EVENT_MISSING_ATTRIBUTE",
        message: `Event "${eventName}" is missing required attribute "${required}". Add the declared scalar attribute before emitting.`,
        eventName,
        attributeName: required,
      });
    }
  }
  for (const attributeName of Object.keys(attributes)) {
    if (!definition.attributes.has(attributeName)) {
      return new InvalidTelemetryEvent({
        code: "OBS_EVENT_UNDECLARED_ATTRIBUTE",
        message: `Event "${eventName}" does not declare attribute "${attributeName}". Add it to the contract or remove it from the event.`,
        eventName,
        attributeName,
      });
    }
  }
  return definition;
};

export type TelemetryContract<Definition extends TelemetryContractInput> = {
  readonly version: 1;
  readonly definition: Definition;
  readonly eventNames: ReadonlyArray<EventName>;
  readonly eventByAlias: ReadonlyMap<string, CompiledEventDefinition>;
  readonly eventByName: ReadonlyMap<EventName, CompiledEventDefinition>;
  readonly auditActionByAlias: ReadonlyMap<string, CompiledAuditActionDefinition>;
  readonly auditActionByName: ReadonlyMap<string, CompiledAuditActionDefinition>;
  readonly metrics: Definition["metrics"];
  readonly metricByAlias: ReadonlyMap<string, CompiledMetricDefinition>;
  readonly metricByName: ReadonlyMap<string, CompiledMetricDefinition>;
};

const isAttributeClassification = Schema.is(AttributeClassification);
const isEventKind = Schema.is(EventKind);
const isEventSeverity = Schema.is(EventSeverity);
const isEventOutcome = Schema.is(EventOutcome);
const auditActionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const canonicalSinkFields = new Set([
  "event.name",
  "event.kind",
  "event.type",
  "event.severity",
  "event.outcome",
  "event.timestamp",
  "event.duration_ms",
  "event.source",
  "event.policy_dropped_attributes",
  "browser.event.id",
  "browser.event.occurred_at",
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "error.type",
  "error.name",
  "error.message",
  "error.status",
  "error.retryable",
  "audit.action",
  "audit.actor.kind",
  "audit.actor.id",
  "audit.resource.type",
  "audit.resource.id",
  "request.id",
  "run.id",
]);
const AttributeDefinitionDocument = Schema.Struct({
  classification: Schema.String,
  required: Schema.Boolean,
  metricLabel: Schema.Boolean,
});
const EventDefinitionDocument = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  defaultSeverity: Schema.String,
  mandatory: Schema.Boolean,
  sampling: Schema.Struct({
    kind: Schema.String,
    rate: Schema.Number.pipe(Schema.optionalKey),
  }),
  attributes: Schema.Record(Schema.String, AttributeDefinitionDocument),
});
const MetricAttributeDefinitionDocument = Schema.Struct({
  classification: Schema.String,
  maximumCardinality: Schema.Number,
  allowedValues: Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])).pipe(
    Schema.optionalKey,
  ),
});
const MetricDefinitionDocument = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  unit: Schema.String,
  kind: Schema.String,
  boundaries: Schema.Array(Schema.Number).pipe(Schema.optionalKey),
  attributes: Schema.Record(Schema.String, MetricAttributeDefinitionDocument),
});
const AuditActionDefinitionDocument = Schema.Struct({
  action: Schema.String,
  resourceType: Schema.String,
  allowedOutcomes: Schema.Array(Schema.String),
});
const TelemetryContractDocument = Schema.Struct({
  version: Schema.Number,
  events: Schema.Record(Schema.String, EventDefinitionDocument),
  metrics: Schema.Record(Schema.String, MetricDefinitionDocument),
  auditActions: Schema.Record(Schema.String, AuditActionDefinitionDocument),
});
const decodeTelemetryContractDocument = Schema.decodeUnknownEffect(TelemetryContractDocument);

const issue = (
  code: ContractIssueCode,
  message: string,
  context: {
    readonly eventAlias?: string;
    readonly eventName?: string;
    readonly attributeName?: string;
    readonly auditActionAlias?: string;
    readonly auditActionName?: string;
    readonly metricAlias?: string;
    readonly metricName?: string;
  } = {},
): ContractIssue => ({ code, message, ...context });

const collectIssues = (definition: TelemetryContractInput): ReadonlyArray<ContractIssue> => {
  const issues: Array<ContractIssue> = [];
  const eventAliasesByName = new Map<string, string>();
  const auditActionAliasesByName = new Map<string, string>();
  const metricAliasesByName = new Map<string, string>();
  if (definition.version !== 1) {
    issues.push(
      issue(
        "OBS_CONTRACT_INVALID_VERSION",
        "Telemetry contract version is invalid. Use version 1.",
      ),
    );
  }
  for (const [alias, event] of Object.entries(definition.events)) {
    if (!isValidEventName(event.name)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_EVENT_NAME",
          `Event "${event.name}" is invalid. Use two to four lowercase dot-separated parts without environment, severity, outcome, or identifier segments.`,
          { eventAlias: alias, eventName: event.name },
        ),
      );
    }
    const existingAlias = eventAliasesByName.get(event.name);
    if (existingAlias !== undefined) {
      issues.push(
        issue(
          "OBS_CONTRACT_DUPLICATE_EVENT_NAME",
          `Event "${event.name}" is declared by aliases "${existingAlias}" and "${alias}". Give each event one canonical name.`,
          { eventAlias: alias, eventName: event.name },
        ),
      );
    } else {
      eventAliasesByName.set(event.name, alias);
    }
    if (!isEventKind(event.kind)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_EVENT_KIND",
          `Event "${event.name}" has an invalid kind. Use request, operation, domain, defect, or audit.`,
          { eventAlias: alias, eventName: event.name },
        ),
      );
    }
    if (!isEventSeverity(event.defaultSeverity)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_DEFAULT_SEVERITY",
          `Event "${event.name}" has an invalid default severity. Use debug, info, warn, error, or fatal.`,
          { eventAlias: alias, eventName: event.name },
        ),
      );
    }
    if (event.sampling.kind === "rate") {
      if (
        !Number.isFinite(event.sampling.rate) ||
        event.sampling.rate <= 0 ||
        event.sampling.rate > 1
      ) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_SAMPLING_RATE",
            `Event "${event.name}" has an invalid sampling rate. Use a finite rate greater than zero and at most one.`,
            { eventAlias: alias, eventName: event.name },
          ),
        );
      }
    } else if (event.sampling.kind !== "always") {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_SAMPLING_RATE",
          `Event "${event.name}" has an invalid sampling policy. Use always or rate.`,
          { eventAlias: alias, eventName: event.name },
        ),
      );
    }
    for (const [attributeName, attribute] of Object.entries(event.attributes)) {
      if (!isValidAttributeName(attributeName)) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_ATTRIBUTE_NAME",
            `Attribute "${attributeName}" is invalid. Use a dotted lowercase name no longer than 128 characters.`,
            { eventAlias: alias, eventName: event.name, attributeName },
          ),
        );
      }
      if (canonicalSinkFields.has(attributeName)) {
        issues.push(
          issue(
            "OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME",
            `Attribute "${attributeName}" is a canonical sink field. Rename the application attribute.`,
            { eventAlias: alias, eventName: event.name, attributeName },
          ),
        );
      }
      if (
        !isAttributeClassification(attribute.classification) ||
        ((attribute.classification === "sensitive" || attribute.classification === "forbidden") &&
          (attribute.required || attribute.metricLabel))
      ) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
            `Attribute "${attributeName}" has an invalid classification or incompatible flags. Use public, internal, sensitive, or forbidden, and set required and metricLabel to false for restricted attributes.`,
            { eventAlias: alias, eventName: event.name, attributeName },
          ),
        );
      }
    }
  }
  for (const [alias, metric] of Object.entries(definition.metrics)) {
    const metricName = metric.name;
    const context = { metricAlias: alias, metricName };
    if (!isValidMetricName(metric.name)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_METRIC_NAME",
          `Metric "${metric.name}" is invalid. Use exactly two lowercase dot-separated parts, no reserved dimensions, and at most 128 characters.`,
          context,
        ),
      );
    }
    const existingMetricAlias = metricAliasesByName.get(metric.name);
    if (existingMetricAlias !== undefined) {
      issues.push(
        issue(
          "OBS_CONTRACT_DUPLICATE_METRIC_NAME",
          `Metric "${metric.name}" is declared by aliases "${existingMetricAlias}" and "${alias}". Give each metric one canonical name.`,
          context,
        ),
      );
    } else {
      metricAliasesByName.set(metric.name, alias);
    }
    if (
      metric.kind !== "counter" &&
      metric.kind !== "histogram" &&
      metric.kind !== "observable_gauge"
    ) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_METRIC_KIND",
          `Metric "${metricName}" has an invalid kind. Use counter, histogram, or observable_gauge.`,
          context,
        ),
      );
    }
    if (!isValidMetricDescription(metric.description)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_METRIC_DESCRIPTION",
          `Metric "${metric.name}" has an invalid description. Use 1 to 1024 characters without control characters.`,
          context,
        ),
      );
    }
    if (!isValidMetricUnit(metric.unit)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_METRIC_UNIT",
          `Metric "${metric.name}" has an invalid unit. Use the runtime unit grammar and at most 63 characters.`,
          context,
        ),
      );
    }
    if (
      (metric.kind === "histogram" &&
        (metric.boundaries === undefined || !isValidHistogramBoundaries(metric.boundaries))) ||
      (metric.kind !== "histogram" && metric.boundaries !== undefined)
    ) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_METRIC_BOUNDARIES",
          `Metric "${metric.name}" has invalid boundaries. Histograms require 1 to 50 sorted finite boundaries and other kinds reject boundaries.`,
          context,
        ),
      );
    }
    if (!isValidMetricAttributeCount(Object.keys(metric.attributes).length)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_METRIC_ATTRIBUTE_DEFINITION",
          `Metric "${metric.name}" exceeds the runtime ceiling of 16 attributes. Remove attributes before compiling.`,
          context,
        ),
      );
    }
    for (const [attributeName, attribute] of Object.entries(metric.attributes)) {
      const attributeContext = { ...context, attributeName };
      if (!isValidMetricAttributeName(attributeName)) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_METRIC_ATTRIBUTE_NAME",
            `Metric attribute "${attributeName}" is invalid. Use a dotted lowercase name no longer than 128 characters.`,
            attributeContext,
          ),
        );
      }
      if (attribute.classification !== "public" && attribute.classification !== "internal") {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_METRIC_ATTRIBUTE_DEFINITION",
            `Metric attribute "${attributeName}" has an invalid classification. Use public or internal; sensitive and forbidden attributes cannot be metric labels.`,
            attributeContext,
          ),
        );
      }
      if (!isValidMetricCardinality(attribute.maximumCardinality)) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_METRIC_CARDINALITY",
            `Metric attribute "${attributeName}" has invalid maximumCardinality. Use an integer from 1 through 100.`,
            attributeContext,
          ),
        );
      }
      if (!validAllowedValues(attribute.allowedValues, attribute.maximumCardinality)) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_METRIC_ALLOWED_VALUES",
            `Metric attribute "${attributeName}" has invalid allowedValues. Use a non-empty unique scalar list no larger than maximumCardinality.`,
            attributeContext,
          ),
        );
      }
    }
  }
  for (const [alias, action] of Object.entries(definition.auditActions)) {
    const existingAlias = auditActionAliasesByName.get(action.action);
    if (existingAlias !== undefined) {
      issues.push(
        issue(
          "OBS_CONTRACT_DUPLICATE_AUDIT_ACTION",
          `Audit action "${action.action}" is declared by aliases "${existingAlias}" and "${alias}". Give each audit action one canonical name.`,
          { auditActionAlias: alias, auditActionName: action.action },
        ),
      );
    } else {
      auditActionAliasesByName.set(action.action, alias);
    }
    if (
      action.action.length > 128 ||
      !auditActionPattern.test(action.action) ||
      action.resourceType.length === 0 ||
      action.allowedOutcomes.length === 0 ||
      action.allowedOutcomes.some((outcome) => !isEventOutcome(outcome))
    ) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_AUDIT_ACTION",
          `Audit action "${alias}" is invalid. Use a dotted lowercase action, a resource type, and at least one allowed outcome.`,
          { auditActionAlias: alias },
        ),
      );
    }
  }
  return issues;
};

export const defineTelemetryContract = Effect.fn("defineTelemetryContract")(function* <
  const Definition extends TelemetryContractInput,
>(
  definition: Definition & StaticEventNames<Definition>,
): Effect.fn.Return<TelemetryContract<Definition>, InvalidTelemetryContract> {
  const documentIsInvalid = yield* decodeTelemetryContractDocument(definition).pipe(
    Effect.match({ onFailure: () => true, onSuccess: () => false }),
  );
  if (documentIsInvalid) {
    return yield* new InvalidTelemetryContract({
      code: "OBS_CONTRACT_INVALID",
      message:
        "Telemetry contract has an invalid outer document. Provide version, events, metrics, and auditActions records.",
      issues: [
        issue(
          "OBS_CONTRACT_INVALID_DOCUMENT",
          "Telemetry contract document is malformed. Provide version, events, metrics, and auditActions records.",
        ),
      ],
    });
  }
  const issues = collectIssues(definition);
  if (issues.length > 0) {
    return yield* new InvalidTelemetryContract({
      code: "OBS_CONTRACT_INVALID",
      message: `Telemetry contract compilation failed with ${issues.length} issue(s). Fix every reported issue and compile again.`,
      issues,
    });
  }
  const eventNames: Array<EventName> = [];
  const eventByAlias = new Map<string, CompiledEventDefinition>();
  const eventByName = new Map<EventName, CompiledEventDefinition>();
  for (const [alias, event] of Object.entries(definition.events)) {
    const name = EventName.make(event.name);
    const attributes = new Map(Object.entries(event.attributes));
    const compiled = {
      alias,
      name,
      kind: event.kind,
      defaultSeverity: event.defaultSeverity,
      mandatory: event.mandatory,
      sampling: event.sampling,
      attributes,
      requiredAttributes: Object.entries(event.attributes)
        .filter((entry) => entry[1].required)
        .map((entry) => entry[0]),
    } satisfies CompiledEventDefinition;
    eventNames.push(name);
    eventByAlias.set(alias, compiled);
    eventByName.set(name, compiled);
  }
  const auditActionByAlias = new Map<string, CompiledAuditActionDefinition>();
  const auditActionByName = new Map<string, CompiledAuditActionDefinition>();
  for (const [alias, action] of Object.entries(definition.auditActions)) {
    const compiled = { alias, ...action };
    auditActionByAlias.set(alias, compiled);
    auditActionByName.set(action.action, compiled);
  }
  const metricByAlias = new Map<string, CompiledMetricDefinition>();
  const metricByName = new Map<string, CompiledMetricDefinition>();
  for (const [alias, metric] of Object.entries(definition.metrics)) {
    const compiled: CompiledMetricDefinition = {
      ...metric,
      alias,
      attributes: new Map(Object.entries(metric.attributes)),
    };
    metricByAlias.set(alias, compiled);
    metricByName.set(metric.name, compiled);
  }
  return {
    version: 1,
    definition,
    eventNames,
    eventByAlias,
    eventByName,
    auditActionByAlias,
    auditActionByName,
    metrics: definition.metrics,
    metricByAlias,
    metricByName,
  };
});
