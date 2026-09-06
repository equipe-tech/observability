#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
RUN_ID="verify-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
STATE_ROOT="${TMPDIR:-/tmp}/observability-$RUN_ID"
ARTIFACT_ROOT="$ROOT/.verification/observability/$RUN_ID"
PROJECT_ARTIFACT_ROOT="$ARTIFACT_ROOT/project-provisioning"
PROVISION_TARGET="$STATE_ROOT/provision-target"
CLI="$ROOT/packages/cli/dist/main.js"
cleanup() {
  local status="$?"
  if test "$status" != "0" && test -d "$PROVISION_TARGET"; then
    mkdir -p "$ARTIFACT_ROOT/failure-state"
    if ! cp -R "$PROVISION_TARGET/." "$ARTIFACT_ROOT/failure-state/"; then
      printf '%s\n' 'Failed to preserve provisioning state. Temporary state was retained.' > "$ARTIFACT_ROOT/failure-preservation.stderr"
      return "$status"
    fi
  fi
  if [[ -n "${STATE_ROOT:-}" && "$STATE_ROOT" == "${TMPDIR:-/tmp}/observability-verify-"* ]]; then
    rm -rf -- "$STATE_ROOT"
  fi
  return "$status"
}
trap cleanup EXIT
mkdir -p "$STATE_ROOT" "$ARTIFACT_ROOT" "$PROJECT_ARTIFACT_ROOT" "$PROVISION_TARGET"
printf 'RUN_ID=%q\nSTATE_ROOT=%q\nARTIFACT_ROOT=%q\nPROVISION_TARGET=%q\nCLI=%q\n' "$RUN_ID" "$STATE_ROOT" "$ARTIFACT_ROOT" "$PROVISION_TARGET" "$CLI" > "$ARTIFACT_ROOT/run.env"
run_capture() {
  local name="$1"
  shift
  printf '%q ' "$@" >> "$ARTIFACT_ROOT/commands.txt"
  printf '\n' >> "$ARTIFACT_ROOT/commands.txt"
  set +e
  "$@" > "$ARTIFACT_ROOT/$name.stdout" 2> "$ARTIFACT_ROOT/$name.stderr"
  local status="$?"
  set -e
  printf '%s\n' "$status" > "$ARTIFACT_ROOT/$name.exit-code"
  return "$status"
}
run_capture build bun run build
CLI_VERSION="$(bun -e 'const manifest = await Bun.file("packages/cli/package.json").json(); console.log(manifest.version)')"
git rev-parse HEAD > "$ARTIFACT_ROOT/build-revision.txt"
bun --version > "$ARTIFACT_ROOT/bun-version.txt"
run_capture cli-version bun "$CLI" --version
test "$(cat "$ARTIFACT_ROOT/cli-version.stdout")" = "observability v$CLI_VERSION"
run_capture cli-help bun "$CLI" --help
for command in dev auth provision env ops setup; do
  grep -Eq "^[[:space:]]+$command[[:space:]]" "$ARTIFACT_ROOT/cli-help.stdout"
done
run_capture provision-create env OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app
grep -F 'created  observability/collector.yaml' "$ARTIFACT_ROOT/provision-create.stdout"
grep -F 'created  observability/kamal.accessory.yml' "$ARTIFACT_ROOT/provision-create.stdout"
grep -F '${env:AXIOM_TOKEN}' "$PROVISION_TARGET/observability/collector.yaml"
for dataset in verify-app-traces verify-app-logs verify-app-metrics; do
  grep -F "$dataset" "$PROVISION_TARGET/observability/kamal.accessory.yml"
done
cp "$PROVISION_TARGET/observability/collector.yaml" "$PROJECT_ARTIFACT_ROOT/first-collector.yaml"
cp "$PROVISION_TARGET/observability/kamal.accessory.yml" "$PROJECT_ARTIFACT_ROOT/first-kamal.accessory.yml"
run_capture provision-repeat env OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app
test "$(grep -c '^unchanged  observability/' "$ARTIFACT_ROOT/provision-repeat.stdout")" = "2"
printf '%s\n' 'receivers: {}' > "$PROVISION_TARGET/observability/collector.yaml"
if run_capture provision-conflict env OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app; then
  exit 1
fi
test "$(cat "$ARTIFACT_ROOT/provision-conflict.exit-code")" = "1"
grep -F 'OBS_CLI_PROVISION_CONFLICT' "$ARTIFACT_ROOT/provision-conflict.stderr"
test "$(cat "$PROVISION_TARGET/observability/collector.yaml")" = 'receivers: {}'
run_capture provision-force env OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app --force
grep -F 'updated  observability/collector.yaml' "$ARTIFACT_ROOT/provision-force.stdout"
grep -F '${env:AXIOM_TOKEN}' "$PROVISION_TARGET/observability/collector.yaml"
cp "$PROVISION_TARGET/observability/collector.yaml" "$PROJECT_ARTIFACT_ROOT/final-collector.yaml"
cp "$PROVISION_TARGET/observability/kamal.accessory.yml" "$PROJECT_ARTIFACT_ROOT/final-kamal.accessory.yml"
test "$(git rev-parse HEAD)" = "$(cat "$ARTIFACT_ROOT/build-revision.txt")"
printf '%s\n' "$ARTIFACT_ROOT"
