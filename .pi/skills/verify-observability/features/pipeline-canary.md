# Pipeline canary

The local canary emits telemetry through the real OTLP endpoint and verifies the Collector file export.

## Sub-features

- `pipeline-trace` exports a root span and a correlated child span.
- `pipeline-log` exports a correlated wide-event log.
- `pipeline-browser` ingests and exports a browser event.
- `pipeline-metric` exports the `canary.operations` counter.
- `pipeline-resource` preserves service and environment attributes.

## How to get to it (user POV)

- Start the local stack with `observability dev up`.
- Run the repository canary with `OBSERVABILITY_E2E=1 bun run test:canary`.
- Inspect the isolated Collector export at `data/otlp.jsonl` under `STATE_ROOT`.

## Driving it with verify-observability

Preconditions:

- The local stack passed the parent skill doctor check.
- `OBSERVABILITY_HOME` points to `STATE_ROOT`.
- `ARTIFACT_ROOT` exists.

- **Emit telemetry.** Run `OBSERVABILITY_HOME="$STATE_ROOT" OBSERVABILITY_E2E=1 bun run test:canary`. The test exits with code `0`.
- **Read the export.** Find `data/otlp.jsonl` under `STATE_ROOT`. The file exists and has content.
- **Identify the run.** Extract `test-[a-z0-9-]+` values from the export. Exactly one unique canary run ID exists in the isolated file.
- **Verify correlation.** Use the canary result as the assertion source. It verifies the trace ID, span parent, correlated log, browser event, and metric value.
- **Verify resources.** Use the canary result as the assertion source. It verifies `service.name`, `service.version`, and `deployment.environment.name` across signals.
- **Capture proof.** Copy `otlp.jsonl` and save the canary output, exit code, and extracted run ID under `ARTIFACT_ROOT`.

## Gotchas

- The test skips unless `OBSERVABILITY_E2E=1` is set.
- The canary reads the CLI package version to derive the default export path.
- A shared `OBSERVABILITY_HOME` can mix old events into the proof. Always use `STATE_ROOT`.
- The viewer page is not the assertion source. The canary reads the Collector file export.
- The deployed canary is a separate feature with credential and dataset requirements.
