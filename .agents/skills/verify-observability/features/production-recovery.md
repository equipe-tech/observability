# Production recovery

## Sub-features

- `queue-outage` accepts signals while the disposable sink is unavailable.
- `queue-restart` restarts the Collector with the same queue directory.
- `queue-drain` proves final receipt and zero queue depth.
- `queue-saturation` proves bounded HTTP 503 responses.
- `queue-health` proves process health during destination failure.
- `queue-metrics` proves depth, capacity, refusal, and enqueue failure metrics.

## How to get to it (user POV)

- Provision `observability/collector.yaml` and `observability/kamal.accessory.yml`.
- Prepare the dedicated host filesystem from the [production runbook](../../../../docs/collector-production-operations.md).
- Probe `http://127.0.0.1:13133/health`.
- Scrape `http://127.0.0.1:8888/metrics`.
- Follow the documented drain, backup, rotation, quarantine, and rollback procedures.

## Driving it with verify-observability

1. Require Docker and `otel/opentelemetry-collector-contrib:0.159.0`.
2. Create a unique `ARTIFACT_ROOT/collector-recovery` directory.
3. Record Docker version and the pinned image digest.
4. Run `bun test packages/cli/test/CollectorAssets.bun.test.ts --timeout 30000`.
5. Run `docker run --rm -v "$PWD/packages/cli/src/assets/local.yaml:/etc/otelcol/config.yaml:ro" otel/opentelemetry-collector-contrib:0.159.0 validate --config=/etc/otelcol/config.yaml`.
6. Run `docker run --rm -e AXIOM_TOKEN=test -e AXIOM_DATASET_TRACES=traces -e AXIOM_DATASET_LOGS=logs -e AXIOM_DATASET_METRICS=metrics -v "$PWD/packages/cli/src/assets/production.yaml:/etc/otelcol/config.yaml:ro" otel/opentelemetry-collector-contrib:0.159.0 validate --config=/etc/otelcol/config.yaml`.
7. Save each command, output, and exit code.
8. Run `OBSERVABILITY_COLLECTOR_RECOVERY=1 OBSERVABILITY_COLLECTOR_RECOVERY_ARTIFACT_ROOT="$ARTIFACT_ROOT/collector-recovery" bun test packages/cli/test/CollectorRecovery.bun.test.ts --timeout 120000`.
9. Require every enabled recovery test to pass.
10. Require unique traces, logs, and metrics before outage, during outage, and after restart.
11. Require queue growth, changed Collector identity, drain completion, and exact receipts.
12. Require four accepted requests and four HTTP 503 responses per saturated signal.
13. Require refusal metrics, enqueue failure metrics, and health during saturation.
14. Verify that no generated container or network remains.
15. Keep the production assets, outputs, digest, and build revision as evidence.

## Gotchas

- The maintained test creates unique networks, containers, ports, queues, and receipt directories.
- `queue_size` counts requests, not bytes or telemetry items.
- Process health does not prove destination availability.
- File storage `max_size` is a fail-safe.
- Docker Desktop cannot prove Linux host ownership.
- The production host must prove owner `10001:10001` and mode `0700` separately.
- At-least-once delivery can duplicate data after an unclean failure.
- Never point this recipe at Axiom or an existing queue.
