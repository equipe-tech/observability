import type { AttributeDefinition } from "./TelemetryContract.ts";
import { defineEventDefinitions } from "./TelemetryContract.ts";

const publicRequired = {
  classification: "public",
  required: true,
  metricLabel: true,
} satisfies AttributeDefinition;

export const organizationContractVersion = 1;

export const organizationEvents = defineEventDefinitions({
  RequestCompleted: {
    name: "request.completed",
    kind: "request",
    defaultSeverity: "info",
    mandatory: true,
    sampling: { kind: "always" },
    attributes: {},
  },
  DependencyCall: {
    name: "dependency.call",
    kind: "operation",
    defaultSeverity: "info",
    mandatory: false,
    sampling: { kind: "always" },
    attributes: {
      "dependency.name": publicRequired,
      "dependency.operation": publicRequired,
    },
  },
  LlmCall: {
    name: "llm.call",
    kind: "operation",
    defaultSeverity: "info",
    mandatory: false,
    sampling: { kind: "always" },
    attributes: {
      "llm.provider": publicRequired,
      "llm.model": publicRequired,
      "llm.operation": publicRequired,
    },
  },
  SchedulerRun: {
    name: "scheduler.run",
    kind: "operation",
    defaultSeverity: "info",
    mandatory: true,
    sampling: { kind: "always" },
    attributes: { "scheduler.job": publicRequired },
  },
  QueueJob: {
    name: "queue.job",
    kind: "operation",
    defaultSeverity: "info",
    mandatory: false,
    sampling: { kind: "always" },
    attributes: {
      "queue.name": publicRequired,
      "queue.job": publicRequired,
    },
  },
  PaymentAttempt: {
    name: "payment.attempt",
    kind: "operation",
    defaultSeverity: "info",
    mandatory: true,
    sampling: { kind: "always" },
    attributes: {
      "payment.provider": publicRequired,
      "payment.operation": publicRequired,
    },
  },
  UsageRecorded: {
    name: "usage.recorded",
    kind: "domain",
    defaultSeverity: "info",
    mandatory: false,
    sampling: { kind: "always" },
    attributes: {
      "usage.type": publicRequired,
      "usage.unit": publicRequired,
    },
  },
  BrowserError: {
    name: "browser.error",
    kind: "defect",
    defaultSeverity: "error",
    mandatory: true,
    sampling: { kind: "always" },
    attributes: { "error.origin": publicRequired },
  },
});
