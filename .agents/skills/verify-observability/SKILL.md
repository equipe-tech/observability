---
name: verify-observability
description: Verify the Observability CLI and local OpenTelemetry pipeline. Use after changes to CLI commands, Collector assets, telemetry export, redaction, or package delivery.
---

# Verify observability

Drive the built CLI and the local telemetry pipeline. Run all commands from the repository root in one Bash session.

Read [the feature map](features/README.md) before a verification run. Select each feature that the change affects.

## Launch

The primary user interface is the short-lived `observability` CLI. Build it once, then start each command with isolated state.

Require Bash, Bun 1.4 or later, and the installed repository dependencies. Docker features also require curl, netcat, Docker Compose, and an active daemon.

```bash
set -euo pipefail
export RUN_ID="verify-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
export STATE_ROOT="${TMPDIR:-/tmp}/observability-$RUN_ID"
export ARTIFACT_ROOT="$PWD/.verification/observability/$RUN_ID"
export PROVISION_TARGET="$STATE_ROOT/provision-target"
export CLI="$PWD/packages/cli/dist/main.js"
mkdir -p "$STATE_ROOT" "$ARTIFACT_ROOT"
printf 'RUN_ID=%q\nSTATE_ROOT=%q\nARTIFACT_ROOT=%q\nPROVISION_TARGET=%q\nCLI=%q\n' "$RUN_ID" "$STATE_ROOT" "$ARTIFACT_ROOT" "$PROVISION_TARGET" "$CLI" > "$ARTIFACT_ROOT/run.env"
printf 'bun run build > %q 2> %q\n' "$ARTIFACT_ROOT/build.stdout" "$ARTIFACT_ROOT/build.stderr" > "$ARTIFACT_ROOT/commands.txt"
bun run build > "$ARTIFACT_ROOT/build.stdout" 2> "$ARTIFACT_ROOT/build.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/build.exit-code"
test "$(cat "$ARTIFACT_ROOT/build.exit-code")" = "0"
test -f "$CLI"
bun --version > "$ARTIFACT_ROOT/bun-version.txt"
git rev-parse HEAD > "$ARTIFACT_ROOT/build-revision.txt"
```

The CLI does not keep a process alive. Start the local stack only for a feature that requires it.

Two file-based runs can use separate `STATE_ROOT` values. Two local stack runs cannot share ports or the fixed Compose project name.

## Doctor

Run this read-only check before each feature recipe:

```bash
EXPECTED_VERSION="$(bun -e 'const manifest = await Bun.file("packages/cli/package.json").json(); console.log(manifest.version)')"
printf 'bun %q --version > %q\n' "$CLI" "$ARTIFACT_ROOT/cli-version.txt" >> "$ARTIFACT_ROOT/commands.txt"
bun "$CLI" --version > "$ARTIFACT_ROOT/cli-version.txt"
test "$(cat "$ARTIFACT_ROOT/cli-version.txt")" = "observability v$EXPECTED_VERSION"
printf 'bun %q --help > %q\n' "$CLI" "$ARTIFACT_ROOT/cli-help.txt" >> "$ARTIFACT_ROOT/commands.txt"
bun "$CLI" --help > "$ARTIFACT_ROOT/cli-help.txt"
for command in dev auth provision env; do
  grep -Eq "^[[:space:]]+$command[[:space:]]" "$ARTIFACT_ROOT/cli-help.txt"
done
test "$(git rev-parse HEAD)" = "$(cat "$ARTIFACT_ROOT/build-revision.txt")"
```

Stop if the version, command list, or revision differs. Rebuild before another check.

For a local stack recipe, also run its service doctor after `dev up`. Never drive an existing shared stack.

## Drive

Use [Project asset setup](features/project-provisioning.md) as the safe baseline proof:

```bash
mkdir -p "$PROVISION_TARGET" "$ARTIFACT_ROOT/project-provisioning"
printf 'OBSERVABILITY_HOME=%q bun %q provision --dir %q --name verify-app\n' "$STATE_ROOT" "$CLI" "$PROVISION_TARGET" >> "$ARTIFACT_ROOT/commands.txt"
OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app > "$ARTIFACT_ROOT/project-provisioning/create.stdout" 2> "$ARTIFACT_ROOT/project-provisioning/create.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/project-provisioning/create.exit-code"
grep -F 'created  observability/collector.yaml' "$ARTIFACT_ROOT/project-provisioning/create.stdout"
grep -F 'created  observability/kamal.accessory.yml' "$ARTIFACT_ROOT/project-provisioning/create.stdout"
grep -F '${env:AXIOM_TOKEN}' "$PROVISION_TARGET/observability/collector.yaml"
for dataset in verify-app-traces verify-app-logs verify-app-metrics; do
  grep -F "$dataset" "$PROVISION_TARGET/observability/kamal.accessory.yml"
done
cp "$PROVISION_TARGET/observability/collector.yaml" "$ARTIFACT_ROOT/project-provisioning/first-collector.yaml"
cp "$PROVISION_TARGET/observability/kamal.accessory.yml" "$ARTIFACT_ROOT/project-provisioning/first-kamal.accessory.yml"
printf 'OBSERVABILITY_HOME=%q bun %q provision --dir %q --name verify-app\n' "$STATE_ROOT" "$CLI" "$PROVISION_TARGET" >> "$ARTIFACT_ROOT/commands.txt"
OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app > "$ARTIFACT_ROOT/project-provisioning/repeat.stdout" 2> "$ARTIFACT_ROOT/project-provisioning/repeat.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/project-provisioning/repeat.exit-code"
test "$(grep -c '^unchanged  observability/' "$ARTIFACT_ROOT/project-provisioning/repeat.stdout")" = "2"
printf '%s\n' 'receivers: {}' > "$PROVISION_TARGET/observability/collector.yaml"
printf 'OBSERVABILITY_HOME=%q bun %q provision --dir %q --name verify-app\n' "$STATE_ROOT" "$CLI" "$PROVISION_TARGET" >> "$ARTIFACT_ROOT/commands.txt"
set +e
OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app > "$ARTIFACT_ROOT/project-provisioning/conflict.stdout" 2> "$ARTIFACT_ROOT/project-provisioning/conflict.stderr"
CONFLICT_EXIT="$?"
set -e
printf '%s\n' "$CONFLICT_EXIT" > "$ARTIFACT_ROOT/project-provisioning/conflict.exit-code"
test "$CONFLICT_EXIT" = "1"
grep -F 'OBS_CLI_PROVISION_CONFLICT' "$ARTIFACT_ROOT/project-provisioning/conflict.stderr"
test "$(cat "$PROVISION_TARGET/observability/collector.yaml")" = 'receivers: {}'
printf 'OBSERVABILITY_HOME=%q bun %q provision --dir %q --name verify-app --force\n' "$STATE_ROOT" "$CLI" "$PROVISION_TARGET" >> "$ARTIFACT_ROOT/commands.txt"
OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app --force > "$ARTIFACT_ROOT/project-provisioning/force.stdout" 2> "$ARTIFACT_ROOT/project-provisioning/force.stderr"
printf '%s\n' "$?" > "$ARTIFACT_ROOT/project-provisioning/force.exit-code"
grep -F 'updated  observability/collector.yaml' "$ARTIFACT_ROOT/project-provisioning/force.stdout"
grep -F '${env:AXIOM_TOKEN}' "$PROVISION_TARGET/observability/collector.yaml"
cp "$PROVISION_TARGET/observability/collector.yaml" "$ARTIFACT_ROOT/project-provisioning/final-collector.yaml"
cp "$PROVISION_TARGET/observability/kamal.accessory.yml" "$ARTIFACT_ROOT/project-provisioning/final-kamal.accessory.yml"
```

This recipe uses the real built CLI. It verifies creation, a second read, idempotency, conflict protection, and forced replacement.

## Evidence

Keep proof under `.verification/observability/$RUN_ID`.

Capture these facts for each proof:

- the exact user command.
- stdout, stderr, and the exit code.
- the build revision and CLI version.
- the action and its resulting state.
- a second read of each file or telemetry side effect.

Exercise the real user path. Do not replace it with internal setters or test-only endpoints.

Use mocks only at an existing production boundary. For dry-run modes, inspect files, network effects, and remote state.

Do not trust the dry-run name. Verify each skipped side effect.

## Cleanup

Run cleanup after success and after each failed attempt:

```bash
if test -n "${COMPOSE_FILE:-}" && test -f "$COMPOSE_FILE"; then
  printf 'bun %q dev down --file %q\n' "$CLI" "$COMPOSE_FILE" >> "$ARTIFACT_ROOT/commands.txt"
  bun "$CLI" dev down --file "$COMPOSE_FILE" > "$ARTIFACT_ROOT/cleanup.stdout" 2> "$ARTIFACT_ROOT/cleanup.stderr"
  printf '%s\n' "$?" > "$ARTIFACT_ROOT/cleanup.exit-code"
  test "$(cat "$ARTIFACT_ROOT/cleanup.exit-code")" = "0"
  test -z "$(docker compose -f "$COMPOSE_FILE" ps --all --services)"
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
test -f "$ARTIFACT_ROOT/run.env"
```

Never stop containers by process name or container name. Remove only the state that this run created.

Keep the evidence directory after cleanup.

## Helpers

The repository owns each verification command:

- `bun packages/cli/dist/main.js` drives the built CLI.
- `bun run test:canary` drives the local telemetry pipeline.
- `bun run test:package` verifies packed artifacts from an external consumer directory.

No extra helper script is required.
