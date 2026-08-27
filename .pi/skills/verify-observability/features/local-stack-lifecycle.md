# Local stack lifecycle

The CLI starts, inspects, and stops the local Collector and telemetry viewer through Docker Compose.

## Sub-features

- `stack-up` starts the Collector and the viewer.
- `stack-status` reports both services through the CLI.
- `stack-viewer` exposes the viewer only on loopback.
- `stack-down` removes the containers that the run started.
- `stack-isolation` keeps generated assets outside the user state directory.

## How to get to it (user POV)

- Run `observability dev up` from a terminal.
- Run `observability dev status` from a terminal.
- Open `http://127.0.0.1:8000/`.
- Run `observability dev down` from a terminal.

## Driving it with verify-observability

Preconditions:

- Docker is available.
- Ports `4317`, `4318`, and `8000` have no listeners.
- No container has the Compose project label `observability-local`.
- The parent skill created `STATE_ROOT` and `ARTIFACT_ROOT`.

- **Launch.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun packages/cli/src/main.ts dev up`. Exit code `0` means Docker Compose accepted the stack and waited for startup.
- **Identify ownership.** Find `docker-compose.yml` under `STATE_ROOT`. The file path must belong to this run.
- **Verify services.** Run `docker compose -f "$COMPOSE_FILE" ps --status running --services`. The sorted output is exactly `collector` and `viewer`.
- **Verify CLI status.** Run `bun packages/cli/src/main.ts dev status --file "$COMPOSE_FILE"`. Exit code `0` and stdout list both services.
- **Verify viewer.** Run `curl --fail --silent --show-error http://127.0.0.1:8000/`. The response body is non-empty.
- **Capture proof.** Save the launch output, status output, active service list, viewer response, and exit codes under `ARTIFACT_ROOT`.
- **Stop.** Run `bun packages/cli/src/main.ts dev down --file "$COMPOSE_FILE"`. Exit code `0` confirms Compose removed the owned stack.
- **Confirm teardown.** Run `docker compose -f "$COMPOSE_FILE" ps --all --services`. The output is empty.

## Gotchas

- The Compose project name is fixed. Two verification runs cannot use the stack concurrently.
- The ports are fixed and loopback-only. Do not remap them without a separate verified Compose file.
- `dev status` without `--file` prepares assets. Use the owned Compose file for a read-only status check.
- The first launch can pull images from the network.
- Cleanup removes `STATE_ROOT` only after Compose teardown.
