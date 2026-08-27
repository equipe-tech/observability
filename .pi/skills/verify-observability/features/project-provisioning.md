# Project asset setup

The CLI writes production Collector and Kamal accessory assets into a disposable target project.

## Sub-features

- `provision-create` creates both production assets.
- `provision-render` replaces the project-name template in dataset names.
- `provision-idempotent` reports unchanged files on a repeated run.
- `provision-conflict` preserves a local modification and reports a typed conflict.
- `provision-force` replaces the modified generated file only when the user selects `--force`.

## How to get to it (user POV)

- Run `observability provision --dir <project> --name <name>`.
- Run the same command again to verify idempotency.
- Run the command with `--force` to replace a modified generated file.

## Driving it with verify-observability

Preconditions:

- The parent skill created `STATE_ROOT` and `ARTIFACT_ROOT`.
- `PROVISION_TARGET="$STATE_ROOT/provision-target"` does not contain user files.
- No `--environment` flag is present.

- **Create the target.** Run `mkdir -p "$PROVISION_TARGET"`.
- **Provision assets.** Run `bun packages/cli/src/main.ts provision --dir "$PROVISION_TARGET" --name verify-app`. Exit code `0` and stdout report two created files.
- **Read generated state.** Read `observability/collector.yaml` and `observability/kamal.accessory.yml` under `PROVISION_TARGET`. The Collector uses `${env:AXIOM_TOKEN}`. The accessory contains `verify-app-traces`, `verify-app-logs`, and `verify-app-metrics`.
- **Verify idempotency.** Run the same command again. Exit code `0` and stdout report both files as unchanged.
- **Create a conflict.** Replace the disposable `collector.yaml` content with `receivers: {}`. Run the command without `--force`. Exit code `1`, stderr contains `OBS_CLI_PROVISION_CONFLICT`, and the file still contains `receivers: {}`.
- **Verify force.** Run the command with `--force`. Exit code `0`, stdout reports the Collector as updated, and the production Collector content returns.
- **Capture proof.** Copy both final assets and save every command output and exit code under `ARTIFACT_ROOT`.

## Gotchas

- Never use a real project directory for this recipe.
- The `--environment` flag creates remote Axiom and Sentry resources. Keep it absent.
- The `--force` flag can replace local edits. Use it only inside `PROVISION_TARGET`.
- The command prints deployment guidance after local asset setup. That text does not mean that a deployment occurred.
