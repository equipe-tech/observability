# Local pipeline

## Sub-features

- `stack-up` starts the Collector and viewer.
- `stack-status` reports both services.
- `viewer-readiness` proves the loopback viewer responds.
- `pipeline-canary` exports traces, logs, metrics, and browser events.
- `pipeline-correlation` proves trace and log relationships.
- `pipeline-redaction` proves secret replacement across signals.
- `stack-down` removes only the run-owned stack.

## How to get to it (user POV)

- Run `observability dev up`.
- Run `observability dev status`.
- Open `http://127.0.0.1:8000/`.
- Run `OBSERVABILITY_E2E=1 bun run test:canary`.
- Run `observability dev down`.

## Driving it with verify-observability

1. Acquire the global stack lock from the parent skill.
2. Verify that ports `4317`, `4318`, and `8000` have no listeners.
3. Verify that no `observability-local` Compose project exists.
4. Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" dev up`.
5. Find the generated `docker-compose.yml` under `STATE_ROOT`.
6. Export its path as `COMPOSE_FILE`.
7. Run `docker compose -f "$COMPOSE_FILE" ps --status running --services | sort`.
8. Require exactly `collector` and `viewer`.
9. Save `docker compose -f "$COMPOSE_FILE" ps --format json` as process identity evidence.
10. Save image names and container IDs from `docker inspect` for both services.
11. Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" dev status --file "$COMPOSE_FILE"`.
12. Require both services in the status output.
13. Run `curl --fail --silent --show-error http://127.0.0.1:8000/`.
14. Save the nonempty viewer response.
15. Run `OBSERVABILITY_HOME="$STATE_ROOT" OBSERVABILITY_E2E=1 bun run test:canary`.
16. Require the telemetry canary, redaction, and browser canary suites to pass. Record each suite and test count.
17. Find `data/otlp.jsonl` under `STATE_ROOT`.
18. Require that the export is nonempty.
19. Copy the export into `ARTIFACT_ROOT`.
20. Require `****` and `[REDACTED]` replacement markers.
21. Save the canary run identifier and command result.
22. Run the parent cleanup procedure.

## Gotchas

- The Compose project and ports are fixed.
- The first start can pull container images.
- Shared state can mix earlier telemetry into evidence.
- The viewer is a readiness view, not the assertion source.
- The test skips unless `OBSERVABILITY_E2E=1` is set.
- The local canary does not prove deployed Axiom delivery.
