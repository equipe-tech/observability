import { Effect, Schema } from "effect";
import { EventName, isValidAttributeName, isValidEventName } from "./EventName.ts";
import type { EventKind, EventOutcome, EventSeverity } from "./TelemetryEvent.ts";
import {
  InvalidTelemetryContract,
  type ContractIssue,
  type ContractIssueCode,
} from "./TelemetryContractError.ts";

export type AttributeClassification = "public" | "internal" | "sensitive" | "forbidden";

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
  readonly kind: EventKind;
  readonly defaultSeverity: EventSeverity;
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

export type MetricDefinitionsInput = {
  readonly [alias: string]: typeof Schema.Json.Type;
};

export type AuditActionDefinitionInput = {
  readonly action: string;
  readonly resourceType: string;
  readonly allowedOutcomes: ReadonlyArray<EventOutcome>;
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
  readonly kind: EventKind;
  readonly defaultSeverity: EventSeverity;
  readonly mandatory: boolean;
  readonly sampling: SamplingPolicyInput;
  readonly attributes: ReadonlyMap<string, AttributeDefinition>;
  readonly requiredAttributes: ReadonlyArray<string>;
};

export type CompiledAuditActionDefinition = AuditActionDefinitionInput & {
  readonly alias: string;
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
};

const attributeClassifications = new Set<string>(["public", "internal", "sensitive", "forbidden"]);
const eventKinds = new Set<string>(["request", "operation", "domain", "defect", "audit"]);
const eventSeverities = new Set<string>(["debug", "info", "warn", "error", "fatal"]);
const eventOutcomes = new Set<string>(["success", "failure", "cancelled"]);
const auditActionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const canonicalSinkFields = new Set([
  "event.name",
  "event.kind",
  "event.type",
  "event.severity",
  "event.outcome",
  "event.timestamp",
  "event.duration_ms",
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "error.type",
  "error.message",
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
const AuditActionDefinitionDocument = Schema.Struct({
  action: Schema.String,
  resourceType: Schema.String,
  allowedOutcomes: Schema.Array(Schema.String),
});
const TelemetryContractDocument = Schema.Struct({
  version: Schema.Number,
  events: Schema.Record(Schema.String, EventDefinitionDocument),
  metrics: Schema.Record(Schema.String, Schema.Any),
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
  } = {},
): ContractIssue => ({ code, message, ...context });

const collectIssues = (definition: TelemetryContractInput): ReadonlyArray<ContractIssue> => {
  const issues: Array<ContractIssue> = [];
  const eventAliasesByName = new Map<string, string>();
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
    if (!eventKinds.has(event.kind)) {
      issues.push(
        issue(
          "OBS_CONTRACT_INVALID_EVENT_KIND",
          `Event "${event.name}" has an invalid kind. Use request, operation, domain, defect, or audit.`,
          { eventAlias: alias, eventName: event.name },
        ),
      );
    }
    if (!eventSeverities.has(event.defaultSeverity)) {
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
        !attributeClassifications.has(attribute.classification) ||
        (attribute.classification === "sensitive" && attribute.metricLabel) ||
        (attribute.classification === "forbidden" && attribute.required)
      ) {
        issues.push(
          issue(
            "OBS_CONTRACT_INVALID_ATTRIBUTE_DEFINITION",
            `Attribute "${attributeName}" has an invalid classification or incompatible flags. Use public or internal, remove metricLabel from sensitive attributes, and remove required from forbidden attributes.`,
            { eventAlias: alias, eventName: event.name, attributeName },
          ),
        );
      }
    }
  }
  for (const [alias, action] of Object.entries(definition.auditActions)) {
    if (
      action.action.length > 128 ||
      !auditActionPattern.test(action.action) ||
      action.resourceType.length === 0 ||
      action.allowedOutcomes.length === 0 ||
      action.allowedOutcomes.some((outcome) => !eventOutcomes.has(outcome))
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
  return {
    version: 1,
    definition,
    eventNames,
    eventByAlias,
    eventByName,
    auditActionByAlias,
    auditActionByName,
    metrics: definition.metrics,
  };
});
