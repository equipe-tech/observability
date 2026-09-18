# Project asset setup

The CLI writes production Collector and Kamal accessory files into a target project.

## Sub-features

- `provision-create` creates the Collector, Kamal accessory, and provision state files.
- `provision-render` replaces the project template in dataset names.
- `provision-idempotent` reports unchanged files on a repeated run.
- `provision-conflict` preserves a local edit and reports a typed conflict.
- `provision-force` replaces an edited generated bundle only with `--force`.
- `provision-mode` selects durable or best-effort assets and protects mode changes.

## How to get to it (user POV)

- Run `observability provision --dir <project> --name <name>`.
- Run the same command again to verify idempotency.
- Run the command with `--force` to replace an edited generated bundle.
- Run the command with `--queue-mode best-effort --force` to change queue mode.

## Driving it with verify-observability

Preconditions:

- The parent skill created `STATE_ROOT` and `ARTIFACT_ROOT`.
- `PROVISION_TARGET="$STATE_ROOT/provision-target"` contains no user files.
- The command contains no `--environment` flag.

- **Create the target.** Run `mkdir -p "$PROVISION_TARGET"`.
- **Provision the files.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app`. Require exit code `0` and three `created` lines.
- **Read the state.** Read the three files under `PROVISION_TARGET/observability`. Require `${env:AXIOM_TOKEN}`, all three `verify-app` dataset names, and `queueMode` set to `durable`.
- **Verify idempotency.** Run the same CLI command. Require exit code `0` and three `unchanged` lines.
- **Create a conflict.** Replace the disposable `collector.yaml` with `receivers: {}`. Run the command without `--force`.
- **Verify protection.** Require exit code `1` and `OBS_CLI_PROVISION_CONFLICT`. Require the edited file to remain unchanged.
- **Replace the edit.** Run the command with `--force`. Require exit code `0` and an `updated` Collector line.
- **Protect a mode change.** Run the command with `--queue-mode best-effort` and no `--force`. Require `OBS_CLI_PROVISION_CONFLICT` and unchanged durable files.
- **Change the mode.** Add `--force`. Require no `file_storage/queue`, no accessory `directories`, three `max_elapsed_time: 5m` values, and `queueMode` set to `best-effort`.
- **Capture proof.** Save all command results. Copy the first and final files to `ARTIFACT_ROOT/project-provisioning`.

## Gotchas

- Never use a real project directory for this recipe.
- The `--environment` flag creates remote Axiom and Sentry resources.
- The `--force` flag can replace local edits.
- Deployment guidance in stdout does not prove that a deployment occurred.
