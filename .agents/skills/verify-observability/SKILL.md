---
name: verify-observability
description: Verify the Observability CLI, local OpenTelemetry pipeline, production assets, provider operations, and package delivery through real user paths.
---

# Verify observability

Drive the built `observability` CLI and the real local telemetry pipeline. Run commands from the repository root in one Bash session.

Read [the feature map](features/README.md). Select every feature that the change affects.

## Launch

The primary surface is the short-lived CLI. The local Collector, telemetry viewer, provider APIs, and installed packages are secondary surfaces.

Require Bash, Bun 1.4 or later, and installed dependencies. Local pipeline proofs also require curl, netcat, Docker Compose, Playwright browsers, and an active Docker daemon.

Run the baseline helper for CLI build, readiness, provisioning, state verification, and cleanup:

```bash
.agents/skills/verify-observability/helpers/verify-project-provisioning.sh
```

The helper prints the retained evidence directory. It removes only its temporary state.

For a manual feature run, initialize isolated paths:

```bash
set -euo pipefail
export RUN_ID="verify-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
export STATE_ROOT="${TMPDIR:-/tmp}/observability-$RUN_ID"
export ARTIFACT_ROOT="$PWD/.verification/observability/$RUN_ID"
export CLI="$PWD/packages/cli/dist/main.js"
export VERIFY_FEATURE="<feature-name>"
mkdir -p "$STATE_ROOT" "$ARTIFACT_ROOT"
printf 'RUN_ID=%q\nSTATE_ROOT=%q\nARTIFACT_ROOT=%q\nCLI=%q\n' "$RUN_ID" "$STATE_ROOT" "$ARTIFACT_ROOT" "$CLI" > "$ARTIFACT_ROOT/run.env"
cleanup_verification() {
  set +e
  local owned_compose="${COMPOSE_FILE:-}"
  local cleanup_status=0
  if test -z "$owned_compose" && test -d "$STATE_ROOT"; then
    owned_compose="$(find "$STATE_ROOT" -name docker-compose.yml -type f -print -quit)"
  fi
  if test -n "$owned_compose" && [[ "$owned_compose" == "$STATE_ROOT"/* ]]; then
    OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" dev down --file "$owned_compose" > "$ARTIFACT_ROOT/cleanup.stdout" 2> "$ARTIFACT_ROOT/cleanup.stderr"
    cleanup_status="$?"
    printf '%s\n' "$cleanup_status" > "$ARTIFACT_ROOT/cleanup.exit-code"
    if ! docker compose -f "$owned_compose" ps --all --quiet > "$ARTIFACT_ROOT/cleanup-containers.txt" 2>> "$ARTIFACT_ROOT/cleanup.stderr"; then
      cleanup_status=1
    elif test -s "$ARTIFACT_ROOT/cleanup-containers.txt"; then
      cleanup_status=1
    fi
  fi
  if test "$cleanup_status" = "0"; then
    case "${STATE_ROOT:-}" in
      "${TMPDIR:-/tmp}"/observability-verify-*) rm -rf -- "$STATE_ROOT" ;;
    esac
    if test -n "${STACK_LOCK:-}" && test -f "$STACK_LOCK/run-id" && test "$(cat "$STACK_LOCK/run-id")" = "$RUN_ID"; then
      rm -rf -- "$STACK_LOCK"
    fi
  else
    printf '%s\n' 'Cleanup failed. The owned state and stack lock were retained for recovery.' >> "$ARTIFACT_ROOT/cleanup.stderr"
  fi
  set -e
  return "$cleanup_status"
}
on_exit() {
  local status="$?"
  trap - EXIT
  cleanup_verification || status="$?"
  exit "$status"
}
trap on_exit EXIT
set +e
if test "$VERIFY_FEATURE" = "package-delivery"; then
  LAUNCH_RESULT="package-delivery"
  bun run test:package > "$ARTIFACT_ROOT/$LAUNCH_RESULT.stdout" 2> "$ARTIFACT_ROOT/$LAUNCH_RESULT.stderr"
else
  LAUNCH_RESULT="build"
  bun run build > "$ARTIFACT_ROOT/$LAUNCH_RESULT.stdout" 2> "$ARTIFACT_ROOT/$LAUNCH_RESULT.stderr"
fi
BUILD_STATUS="$?"
set -e
printf '%s\n' "$BUILD_STATUS" > "$ARTIFACT_ROOT/$LAUNCH_RESULT.exit-code"
test "$BUILD_STATUS" = "0"
git rev-parse HEAD > "$ARTIFACT_ROOT/build-revision.txt"
test -f "$CLI"
```

The CLI exits after each command. Start the local stack only for local pipeline features.

Two file-based runs can use separate `STATE_ROOT` values. Local stack runs cannot share ports or the fixed Compose project.

## Doctor

Run these read-only checks before each recipe:

```bash
EXPECTED_VERSION="$(bun -e 'const manifest = await Bun.file("packages/cli/package.json").json(); console.log(manifest.version)')"
bun --version > "$ARTIFACT_ROOT/bun-version.txt"
bun "$CLI" --version > "$ARTIFACT_ROOT/cli-version.txt"
test "$(cat "$ARTIFACT_ROOT/cli-version.txt")" = "observability v$EXPECTED_VERSION"
bun "$CLI" --help > "$ARTIFACT_ROOT/cli-help.txt"
for command in dev auth provision env ops setup; do
  grep -Eq "^[[:space:]]+$command[[:space:]]" "$ARTIFACT_ROOT/cli-help.txt"
done
test "$(git rev-parse HEAD)" = "$(cat "$ARTIFACT_ROOT/build-revision.txt")"
```

If the revision differs, rebuild before verification.

Before local stack control, verify ownership and ports:

```bash
export STACK_LOCK="${TMPDIR:-/tmp}/observability-verification-local-stack.lock"
if ! mkdir "$STACK_LOCK" 2>/dev/null; then
  printf '%s\n' 'Another verification run or a stale lock owns the local stack lock.' >&2
  printf '%s\n' 'Read owner-pid and run-id. Remove the lock only when the process is absent and no observability-local containers exist.' >&2
  exit 1
fi
printf '%s\n' "$RUN_ID" > "$STACK_LOCK/run-id"
printf '%s\n' "$$" > "$STACK_LOCK/owner-pid"
for port in 4317 4318 8000; do
  if nc -z 127.0.0.1 "$port"; then
    printf 'Port %s already has a listener.\n' "$port" >&2
    exit 1
  fi
done
if ! EXISTING_STACK="$(docker ps -a --filter label=com.docker.compose.project=observability-local --format '{{.ID}}')"; then
  printf '%s\n' 'Docker failed while checking for an existing local stack.' >&2
  exit 1
fi
test -z "$EXISTING_STACK"
```

After `dev up`, require `collector` and `viewer` from the generated Compose file. Require a successful request to `http://127.0.0.1:8000/`.

Check authentication state without exposing credentials:

```bash
CREDENTIALS_FILE="$STATE_ROOT/credentials.json"
if test -f "$CREDENTIALS_FILE"; then
  test "$(CREDENTIALS_FILE="$CREDENTIALS_FILE" bun -e 'import { stat } from "node:fs/promises"; console.log(((await stat(process.env.CREDENTIALS_FILE)).mode & 0o777).toString(8))')" = "600"
  OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" auth status > "$ARTIFACT_ROOT/auth-status.stdout" 2> "$ARTIFACT_ROOT/auth-status.stderr"
else
  printf '%s\n' 'BLOCKED: isolated provider credentials are absent.' > "$ARTIFACT_ROOT/auth-status.blocked"
fi
```

Provider authentication requires dedicated verification accounts. If credentials are absent, report the provider recipe as blocked.

## Drive

Use [Project provisioning](features/project-provisioning.md) as the safe baseline proof.

Use [Setup and release](features/setup-release.md) for setup planning, generated application verification, and release prerequisites.

Use [Local pipeline](features/local-pipeline.md) for stack lifecycle, viewer readiness, telemetry export, and redaction.

Use [Provider operations](features/provider-operations.md) only with dedicated non-production organizations and projects.

Use [Production recovery](features/production-recovery.md) for persistent queue, saturation, health, and recovery behavior.

Use [Package delivery](features/package-delivery.md) for packed consumer, declaration, runtime, CLI, and asset verification.

Do not substitute unit tests for a mapped user path. Use loopback servers only at existing HTTP provider boundaries.

## Evidence

Keep proof under `.verification/observability/$RUN_ID`.

Capture these facts:

- Record each exact command.
- Save stdout, stderr, and the exit code separately.
- Save the Git revision, Bun version, and CLI version.
- Capture the user action and its resulting state.
- Verify each side effect through a second observable view.
- Copy generated files or telemetry exports before cleanup.
- Redact tokens, DSNs, query text, and provider response bodies.

A dry-run label does not prove safety. Verify that files, network calls, and remote state did not change.

## Cleanup

Stop only the stack that this run started:

```bash
trap - EXIT
cleanup_verification
test ! -e "$STATE_ROOT"
test -d "$ARTIFACT_ROOT"
test -f "$ARTIFACT_ROOT/run.env"
if test -f "$ARTIFACT_ROOT/cleanup-containers.txt"; then
  test ! -s "$ARTIFACT_ROOT/cleanup-containers.txt"
fi
```

Run cleanup after success and after each failure. Keep the evidence directory.

## Helpers

The executable baseline helper is:

```bash
.agents/skills/verify-observability/helpers/verify-project-provisioning.sh
```

Repository-owned drivers are:

```bash
bun packages/cli/dist/main.js
OBSERVABILITY_E2E=1 bun run test:canary
OBSERVABILITY_COLLECTOR_RECOVERY=1 bun test packages/cli/test/CollectorRecovery.bun.test.ts --timeout 120000
bun run test:package
```

Use the repository CLI loopback tests for deterministic prompt and provider-boundary checks. Use a PTY only for dedicated credential login proofs.
