# Data policy reference

The telemetry package compiles one additive `DataPolicy` during bootstrap. The compiled policy sanitizes server signals before an OTLP exporter receives them.

## Policy declaration

Use `definePolicy` to preserve literal attribute definitions. Use dotted lowercase attribute names with at most 128 characters.

```ts
import { definePolicy } from "@equipe-tech/observability";

export const policy = definePolicy({
  attributes: {
    "customer.tier": {
      classification: "public",
      required: false,
      metricLabel: true,
    },
    "customer.email": {
      classification: "sensitive",
      required: false,
      metricLabel: false,
    },
  },
  blockedKeys: [],
  blockedValuePatterns: [],
});
```

`parseDataPolicy` compiles the declaration. Compilation adds the application rules to the immutable base rules. An application cannot remove a base key or value rule. Application blocked-value expressions always compile with global and case-insensitive flags, so every match is replaced.

## Classifications

The policy supports these classifications:

- `public` permits a stable scalar value.
- `internal` permits a stable scalar value.
- `sensitive` masks a log, event, span, defect, or resource value as `****`.
- `forbidden` rejects a declared producer value or drops an untrusted value.

Metric labels never use masked values. A metric facade rejects a blocked label with `MetricsError` code `POLICY_BLOCKED`. Its `policyReason` identifies the safe rejection category without carrying the key or value. A direct Effect metric drops the label during collection and reports the same reason in the flush result. `service.instance.id` remains a hard direct-metric export failure.

The package-owned logger is the policy boundary for Effect log records and delegated output. Applications must register delegated loggers through the observability composition path so the package can sanitize each record first. Do not add a raw logger downstream of the observability layer because it would receive the unsanitized Effect record.

## Safe failures

`InvalidDataPolicy` aggregates policy issues under `OBS_POLICY_INVALID`. Issues include a closed rule code and safe bounded context. They never contain a rejected value.

Bootstrap wraps `InvalidDataPolicy` in `InvalidObservabilityConfig`. The wrapper uses `field: "policy"` and keeps the aggregated error as its cause.

Browser ingestion does not reject a valid batch because one field violates the policy. The response reports bounded `accepted`, `redacted`, and `dropped` counts.

## Signal bounds

Browser events keep at most 32 fields and 1,024 characters per value. Server events keep 128 fields and 16,384 characters per value. Logs and spans keep 128 fields and 32,768 characters per value. A span keeps the earliest 128 events and earliest 128 links. OTLP reports exact dropped attribute, event, and link counts after policy and bounds. Defect context and the complete defect tag map each keep 128 fields, while defect text and stack traces keep 65,536 characters. Resources keep 128 attributes and 8,192 characters per value. Metrics keep 16 labels and 64 characters per string label. Metric keys require dotted names. The reserved identifiers `unit`, `time_unit`, `service.instance.id`, `trace.id`, `span.id`, `user.id`, and `session.id` are forbidden. Each label accepts at most 100 distinct values per instrument lifetime.

Metric policy rejection uses `POLICY_BLOCKED`. Cardinality and field-count bounds use `LIMIT_EXCEEDED`.

Server truncation preserves the bounded prefix. Policy decisions emit `rule: "bounds"` with `action: "truncated"` or `action: "dropped"`. `dropped` counts every field removed by policy or bounds.

`layer`, `layerOtlp`, and `layerFromEnv` accept `resourceAttributes`. Resource additions merge at layer construction after policy classification. Duplicate canonical or application keys stop construction with `OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE`.

## Defect adapter handoff

OBS-61 owns the Sentry adapters. The adapter must meet these requirements:

- Capture only `UnexpectedDefect` values.
- Set `sendDefaultPii` to `false`.
- Run `sanitizeDefectEnvelope` in `beforeSend`.
- Return `null` when `sanitizeDefectEnvelope` returns `Option.none`.

`Option.none` is required when a forbidden defect context or tag would otherwise produce a partial envelope.

- Preserve the policy-approved correlation tags.

`sanitizeDefectEnvelope` is destination-neutral. The telemetry package does not import a Sentry SDK.
