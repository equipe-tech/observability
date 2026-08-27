# Local stack lifecycle

The CLI starts, inspects, and stops the local Collector and telemetry viewer through Docker Compose.

## Sub-features

- `stack-up` starts the Collector and the viewer.
- `stack-status` reports both services through the CLI.
- `stack-viewer` exposes the viewer only on loopback.
- `stack-down` removes the containers that the run started.
- `stack-isolation` keeps generated files outside the user state directory.

## How to get to it (user POV)

- Run `observability dev up` from a terminal.
- Run `observability dev status` from a terminal.
- Open `http://127.0.0.1:8000/`.
- Run `observability dev down` from a terminal.

## Driving it with verify-observability

Preconditions:

- Docker Compose and the Docker daemon are available.
- Ports `4317`, `4318`, and `8000` have no listeners.
- No container has the Compose project label `observability-local`.
- The parent skill created `STATE_ROOT` and `ARTIFACT_ROOT`.

- **Refuse shared state.** Run `docker ps -a --filter label=com.docker.compose.project=observability-local --format '{{.ID}}'`. Stop if the output is not empty.
- **Verify ports.** Run `nc -z 127.0.0.1 <port>` for each fixed port. Stop if any command succeeds.
- **Start the stack.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" dev up`. Require exit code `0`.
- **Identify ownership.** Find `docker-compose.yml` under `STATE_ROOT`. Export its path as `COMPOSE_FILE`.
- **Run the service doctor.** Run `docker compose -f "$COMPOSE_FILE" ps --status running --services | sort`. Require exactly `collector` and `viewer`.
- **Verify CLI status.** Run `bun "$CLI" dev status --file "$COMPOSE_FILE"`. Require exit code `0` and both services.
- **Verify the viewer.** Run `curl --fail --silent --show-error http://127.0.0.1:8000/`. Require a nonempty response.
- **Capture proof.** Save launch output, status output, the service list, the viewer response, and all exit codes.
- **Stop the stack.** Run `bun "$CLI" dev down --file "$COMPOSE_FILE"`. Require exit code `0`.
- **Verify teardown.** Run `docker compose -f "$COMPOSE_FILE" ps --all --services`. Require empty output.

## Gotchas

- The Compose project name is fixed.
- Two local stack runs cannot execute at the same time.
- The ports are fixed and loopback-only.
- The first start can pull container images from the network.
- Run cleanup after every failed start.
