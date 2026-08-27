# Pipeline canary

The local canary sends telemetry through OTLP and verifies the Collector file export.

## Sub-features

- `pipeline-trace` exports a root span and a correlated child span.
- `pipeline-log` exports a correlated wide-event log.
- `pipeline-browser` accepts and exports a browser event.
- `pipeline-metric` exports the `canary.operations` counter.
- `pipeline-resource` exports service attributes and equal `deployment.environment.name` and `deployment.environment` resource values for all signals.
- `pipeline-redaction` removes secret fields and secret values across all signals.

## How to get to it (user POV)

- Start the local stack with `observability dev up`.
- Run `OBSERVABILITY_E2E=1 bun run test:canary`.
- Inspect `data/otlp.jsonl` under the isolated `STATE_ROOT`.

## Driving it with verify-observability

Preconditions:

- The local stack passed the service doctor.
- `OBSERVABILITY_HOME` points to `STATE_ROOT`.
- `ARTIFACT_ROOT` exists.

- **Send telemetry.** Run `OBSERVABILITY_HOME="$STATE_ROOT" OBSERVABILITY_E2E=1 bun run test:canary`. Require exit code `0`.
- **Read the export.** Find `data/otlp.jsonl` under `STATE_ROOT`. Require a nonempty file.
- **Identify the run.** Extract values that match `test-[a-z0-9-]+`. Require one unique canary run ID in fresh state.
- **Verify correlation.** Require the canary result. It verifies trace IDs, span parentage, a correlated log, a browser event, and a metric.
- **Verify resources.** Require the canary result. It verifies service fields and equal canonical and transition environment values for all signals.
- **Verify redaction.** Require the canary result. It rejects generated secrets and preserves the negative controls.
- **Verify replacements.** Search the export for `****` and `[REDACTED]`. Require both replacement forms.
- **Capture proof.** Copy `otlp.jsonl`. Save the command result, run ID, and replacement search output.

## Gotchas

- The test skips unless `OBSERVABILITY_E2E=1` is set.
- Shared state can mix old events into the proof.
- The viewer page is not the assertion source.
- Do not print generated secret markers outside the canary process.
- The local canary does not verify the deployed Collector.
