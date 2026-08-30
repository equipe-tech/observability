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

`parseDataPolicy` compiles the declaration. Compilation adds the application rules to the immutable base rules. An application cannot remove a base key or value rule.

## Classifications

The policy supports these classifications:

- `public` permits a stable scalar value.
- `internal` permits a stable scalar value.
- `sensitive` masks a log, event, span, defect, or resource value as `****`.
- `forbidden` rejects a declared producer value or drops an untrusted value.

Metric labels never use masked values. A metric facade rejects a blocked label with `MetricsError` code `POLICY_BLOCKED`. A direct Effect metric drops the label during collection and reports `POLICY_BLOCKED` in the flush result.

## Safe failures

`InvalidDataPolicy` aggregates policy issues under `OBS_POLICY_INVALID`. Issues include a closed rule code and safe bounded context. They never contain a rejected value.

Bootstrap wraps `InvalidDataPolicy` in `InvalidObservabilityConfig`. The wrapper uses `field: "policy"` and keeps the aggregated error as its cause.

Browser ingestion does not reject a valid batch because one field violates the policy. The response reports bounded `accepted`, `redacted`, and `dropped` counts.

## Defect adapter handoff

OBS-61 owns the Sentry adapters. The adapter must meet these requirements:

- Capture only `UnexpectedDefect` values.
- Set `sendDefaultPii` to `false`.
- Run `sanitizeDefectEnvelope` in `beforeSend`.
- Return `null` when policy application fails.
- Preserve the policy-approved correlation tags.

`sanitizeDefectEnvelope` is destination-neutral. The telemetry package does not import a Sentry SDK.
