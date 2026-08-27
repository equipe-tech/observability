---
name: verify-observability
description: Verify the observability CLI and local OpenTelemetry pipeline with disposable Docker state. Use after changes to stack lifecycle, telemetry export, redaction, package delivery, or project asset setup.
---

# Verify observability

Drive the documented CLI and the local telemetry pipeline. Run all commands from the repository root in one Bash session.

Read [the feature map](features/README.md) before a verification run. Use the selected feature file for the requested behavior.

## Launch

Require Bash, curl, netcat, Bun 1.4 or later, Docker Compose, and an active Docker daemon. The first launch can pull container images.

Create one run identity and two separate directories:

```bash
export RUN_ID="verify-$(date -u +%Y%m%dT%H%M%SZ)-$$"
export STATE_ROOT="${TMPDIR:-/tmp}/observability-$RUN_ID"
export ARTIFACT_ROOT="$PWD/.verification/observability/$RUN_ID"
mkdir -p "$STATE_ROOT" "$ARTIFACT_ROOT"
printf 'RUN_ID=%s\nSTATE_ROOT=%s\nARTIFACT_ROOT=%s\n' "$RUN_ID" "$STATE_ROOT" "$ARTIFACT_ROOT" > "$ARTIFACT_ROOT/run.env"
```

Refuse to start if another `observability-local` stack exists. The Compose project name and loopback ports are shared.

```bash
if docker ps -a --filter label=com.docker.compose.project=observability-local --format '{{.ID}}' | grep -q .; then
  printf '%s\n' 'An observability-local stack already exists.' >&2
  exit 1
fi
for port in 4317 4318 8000; do
  if nc -z 127.0.0.1 "$port" > /dev/null 2>&1; then
    printf 'Port %s already has a listener.\n' "$port" >&2
    exit 1
  fi
done
bun --version > "$ARTIFACT_ROOT/bun-version.txt"
docker info --format '{{.ServerVersion}}' > "$ARTIFACT_ROOT/docker-version.txt"
git rev-parse HEAD > "$ARTIFACT_ROOT/build-revision.txt"
```

Start the stack through the real CLI. Record the action and its output.

```bash
printf 'OBSERVABILITY_HOME=%q bun packages/cli/src/main.ts dev up > %q 2> %q\n' "$STATE_ROOT" "$ARTIFACT_ROOT/launch.stdout" "$ARTIFACT_ROOT/launch.stderr" >> "$ARTIFACT_ROOT/commands.txt"
OBSERVABILITY_HOME="$STATE_ROOT" bun packages/cli/src/main.ts dev up > "$ARTIFACT_ROOT/launch.stdout" 2> "$ARTIFACT_ROOT/launch.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/launch.exit-code"
test "$(cat "$ARTIFACT_ROOT/launch.exit-code")" = "0"
export COMPOSE_FILE="$(find "$STATE_ROOT" -type f -name docker-compose.yml -print -quit)"
test -n "$COMPOSE_FILE"
printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILE" >> "$ARTIFACT_ROOT/run.env"
```

## Doctor

Run this read-only check before a feature recipe:

```bash
bun packages/cli/src/main.ts --version > "$ARTIFACT_ROOT/cli-version.txt"
docker compose -f "$COMPOSE_FILE" ps --status running --services | sort > "$ARTIFACT_ROOT/doctor.services"
printf 'collector\nviewer\n' | diff -u - "$ARTIFACT_ROOT/doctor.services"
curl --fail --silent --show-error http://127.0.0.1:8000/ > "$ARTIFACT_ROOT/viewer.html"
printf 'bun packages/cli/src/main.ts dev status --file %q > %q 2> %q\n' "$COMPOSE_FILE" "$ARTIFACT_ROOT/status.stdout" "$ARTIFACT_ROOT/status.stderr" >> "$ARTIFACT_ROOT/commands.txt"
bun packages/cli/src/main.ts dev status --file "$COMPOSE_FILE" > "$ARTIFACT_ROOT/status.stdout" 2> "$ARTIFACT_ROOT/status.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/status.exit-code"
test "$(cat "$ARTIFACT_ROOT/status.exit-code")" = "0"
```

Continue only when both services run, the viewer responds, and the CLI status exits with code `0`.

## Drive

Use [Pipeline canary](features/pipeline-canary.md) as the baseline proof:

```bash
printf 'OBSERVABILITY_HOME=%q OBSERVABILITY_E2E=1 bun run test:canary > %q 2> %q\n' "$STATE_ROOT" "$ARTIFACT_ROOT/canary.stdout" "$ARTIFACT_ROOT/canary.stderr" >> "$ARTIFACT_ROOT/commands.txt"
OBSERVABILITY_HOME="$STATE_ROOT" OBSERVABILITY_E2E=1 bun run test:canary > "$ARTIFACT_ROOT/canary.stdout" 2> "$ARTIFACT_ROOT/canary.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/canary.exit-code"
test "$(cat "$ARTIFACT_ROOT/canary.exit-code")" = "0"
export EXPORT_FILE="$(find "$STATE_ROOT" -type f -path '*/data/otlp.jsonl' -print -quit)"
test -n "$EXPORT_FILE"
cp "$EXPORT_FILE" "$ARTIFACT_ROOT/otlp.jsonl"
grep -Eo 'test-[a-z0-9-]+' "$ARTIFACT_ROOT/otlp.jsonl" | sort -u > "$ARTIFACT_ROOT/canary-run-ids.txt"
test "$(wc -l < "$ARTIFACT_ROOT/canary-run-ids.txt" | tr -d ' ')" = "1"
printf 'EXPORT_FILE=%s\n' "$EXPORT_FILE" >> "$ARTIFACT_ROOT/run.env"
```

Require exit code `0`. The canary proves correlated traces, logs, metrics, browser ingestion, resource attributes, and sensitive-data redaction.

## Evidence

Keep evidence under `.verification/observability/$RUN_ID`.

Capture these facts for each proof:

- the exact command;
- stdout, stderr, and the exit code;
- `doctor.services` and `status.stdout`;
- the isolated `otlp.jsonl` export;
- the canary run ID;
- generated files for write-based CLI features.

Capture the action and the result. Do not use the viewer page alone as proof. Verify file writes and telemetry exports through a second read.

## Cleanup

Run cleanup after success and after each failed attempt:

```bash
if test -n "${COMPOSE_FILE:-}" && test -f "$COMPOSE_FILE"; then
  printf 'bun packages/cli/src/main.ts dev down --file %q > %q 2> %q\n' "$COMPOSE_FILE" "$ARTIFACT_ROOT/cleanup.stdout" "$ARTIFACT_ROOT/cleanup.stderr" >> "$ARTIFACT_ROOT/commands.txt"
  bun packages/cli/src/main.ts dev down --file "$COMPOSE_FILE" > "$ARTIFACT_ROOT/cleanup.stdout" 2> "$ARTIFACT_ROOT/cleanup.stderr"
  printf '%s\n' "$?" > "$ARTIFACT_ROOT/cleanup.exit-code"
  test "$(cat "$ARTIFACT_ROOT/cleanup.exit-code")" = "0"
fi
if test -z "${STATE_ROOT:-}"; then
  printf '%s\n' 'STATE_ROOT is empty. Cleanup stopped.' >&2
  exit 1
fi
case "$STATE_ROOT" in
  "${TMPDIR:-/tmp}"/observability-verify-*) rm -rf -- "$STATE_ROOT" ;;
  *) printf 'STATE_ROOT is outside the verification prefix: %s\n' "$STATE_ROOT" >&2; exit 1 ;;
esac
test ! -e "$STATE_ROOT"
test -d "$ARTIFACT_ROOT"
```

Keep the evidence directory after cleanup. Never stop containers by process name or container name.

## Helpers

The repository owns the verification commands:

- `bun packages/cli/src/main.ts` drives the CLI.
- `bun run test:canary` drives the local telemetry pipeline.
- `bun run test:package` verifies packed artifacts from an external consumer directory.

Do not add a second wrapper unless a repository command cannot express a required user path.
