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
- Prepare the dedicated host filesystem from the production runbook.
- Probe `http://127.0.0.1:13133/health`.
- Scrape `http://127.0.0.1:8888/metrics`.
- Follow the documented drain, backup, rotation, quarantine, and rollback procedures.

## Driving it with verify-observability

1. Require Docker and the pinned Collector image.
2. Create a unique `ARTIFACT_ROOT/collector-recovery` directory.
3. Record Docker version and the pinned image digest.
4. Run `bun test packages/cli/test/CollectorAssets.bun.test.ts --timeout 30000`.
5. Validate both shipped Collector configurations with the pinned image.
6. Save each command, output, and exit code.
7. Run `OBSERVABILITY_COLLECTOR_RECOVERY=1 OBSERVABILITY_COLLECTOR_RECOVERY_ARTIFACT_ROOT="$ARTIFACT_ROOT/collector-recovery" bun test packages/cli/test/CollectorRecovery.bun.test.ts --timeout 120000`.
8. Require every enabled recovery test to pass.
9. Require unique traces, logs, and metrics before outage, during outage, and after restart.
10. Require queue growth, changed Collector identity, drain completion, and exact receipts.
11. Require four accepted requests and four HTTP 503 responses per saturated signal.
12. Require refusal metrics, enqueue failure metrics, and health during saturation.
13. Verify that no generated container or network remains.
14. Keep the production assets, outputs, digest, and build revision as evidence.

## Gotchas

- The maintained test creates unique networks, containers, ports, queues, and receipt directories.
- `queue_size` counts requests, not bytes or telemetry items.
- Process health does not prove destination availability.
- File storage `max_size` is a fail-safe.
- Docker Desktop cannot prove Linux host ownership.
- The production host must prove owner `10001:10001` and mode `0700` separately.
- At-least-once delivery can duplicate data after an unclean failure.
- Never point this recipe at Axiom or an existing queue.
