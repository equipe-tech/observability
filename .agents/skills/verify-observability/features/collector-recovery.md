# Collector production recovery

This recipe proves persistent queue recovery and bounded rejection with the pinned Collector image. It never uses provider credentials or existing Docker resources.

## Sub-features

- `queue-outage` accepts traces, logs, and metrics while the disposable sink is unavailable.
- `queue-restart` restarts the source Collector with the same disposable queue directory.
- `queue-drain` recovers the sink and proves exact receipt and zero queue depth.
- `queue-saturation` fills a four-request canary queue and proves synchronous HTTP 503 responses.
- `queue-health` proves that destination outage and queue saturation keep the process health endpoint available.
- `queue-metrics` proves capacity, depth, receiver refusal, and enqueue failure metrics.

## How to get to it (user POV)

- Provision `observability/collector.yaml` and `observability/kamal.accessory.yml` into a project.
- Prepare the dedicated host filesystem and directory described in `docs/collector-production-operations.md`.
- Probe `http://127.0.0.1:13133/health` from the host.
- Scrape `http://127.0.0.1:8888/metrics` from the host.
- Follow the documented inspect, drain, backup, token rotation, quarantine, and rollback sequences.

## Driving it with verify-observability

Preconditions:

- Docker is available.
- `otel/opentelemetry-collector-contrib:0.159.0` can run.
- The parent skill created `ARTIFACT_ROOT`.
- No resource name begins with the test's generated `obs10-<pid>-<uuid>` prefix.

1. Record `docker version` and the pinned image digest in the artifact directory.
2. Run `bun test packages/cli/test/CollectorAssets.bun.test.ts --timeout 30000` and record stdout, stderr, and exit code.
3. Run the pinned production validation command from the implementation brief and record stdout, stderr, and exit code.
4. Run `OBSERVABILITY_COLLECTOR_RECOVERY=1 OBSERVABILITY_COLLECTOR_RECOVERY_ARTIFACT_ROOT="$ARTIFACT_ROOT/collector-recovery" bun test packages/cli/test/CollectorRecovery.bun.test.ts --timeout 120000` and record stdout, stderr, and exit code.
5. Require one passing recovery test and no failures.
6. Confirm that `docker ps -a --format '{{.Names}}'` and `docker network ls --format '{{.Name}}'` contain no resource with the generated prefix after the test.
7. Copy the production Collector asset, accessory asset, test output, pinned image digest, and build revision into `ARTIFACT_ROOT/collector-recovery`.

The maintained test creates a unique Docker network, unique bind-mounted queue and receipt directories, random loopback host ports, one source Collector, and disposable sink Collectors. It sends unique event identities. It verifies accepted outage requests, queue growth for all signals, process health, a changed source container identity after restart, exact sink receipt, complete drain, four accepted saturation requests and four HTTP 503 responses per signal, refusal metrics, enqueue failure metrics, and health during saturation. Cleanup removes only resources with the generated prefix and only its temporary directory.

## Gotchas

- The production queue capacity is 64 requests per exporter. The saturation proof intentionally uses four requests so the test stays fast.
- `queue_size` counts export requests, not bytes or telemetry items.
- The health endpoint reports process and component startup, not destination availability.
- File storage `max_size` is a fail-safe, not the normal rejection boundary.
- Docker Desktop bind-mount permissions differ from a Linux production host. The canary runs the source as `10001:10001`, while production additionally requires owner `10001:10001` and mode `0700`.
- At-least-once delivery may duplicate data after an unclean failure. The maintained clean outage case expects exactly one receipt.
- Never point this recipe at Axiom, production credentials, an existing queue, or fixed shared ports.
