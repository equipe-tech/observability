# Project asset setup

The CLI writes production Collector and Kamal accessory files into a target project.

## Sub-features

- `provision-create` creates both production files.
- `provision-render` replaces the project template in dataset names.
- `provision-idempotent` reports unchanged files on a repeated run.
- `provision-conflict` preserves a local edit and reports a typed conflict.
- `provision-force` replaces the edited generated file only with `--force`.

## How to get to it (user POV)

- Run `observability provision --dir <project> --name <name>`.
- Run the same command again to verify idempotency.
- Run the command with `--force` to replace an edited generated file.

## Driving it with verify-observability

Preconditions:

- The parent skill created `STATE_ROOT` and `ARTIFACT_ROOT`.
- `PROVISION_TARGET="$STATE_ROOT/provision-target"` contains no user files.
- The command contains no `--environment` flag.

- **Create the target.** Run `mkdir -p "$PROVISION_TARGET"`.
- **Provision the files.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" provision --dir "$PROVISION_TARGET" --name verify-app`. Require exit code `0` and two `created` lines.
- **Read the state.** Read both files under `PROVISION_TARGET/observability`. Require `${env:AXIOM_TOKEN}` and all three `verify-app` dataset names.
- **Verify idempotency.** Run the same CLI command. Require exit code `0` and two `unchanged` lines.
- **Create a conflict.** Replace the disposable `collector.yaml` with `receivers: {}`. Run the command without `--force`.
- **Verify protection.** Require exit code `1` and `OBS_CLI_PROVISION_CONFLICT`. Require the edited file to remain unchanged.
- **Replace the edit.** Run the command with `--force`. Require exit code `0` and an `updated` Collector line.
- **Capture proof.** Save all command results. Copy the first and final files to `ARTIFACT_ROOT/project-provisioning`.

## Gotchas

- Never use a real project directory for this recipe.
- The `--environment` flag creates remote Axiom and Sentry resources.
- The `--force` flag can replace local edits.
- Deployment guidance in stdout does not prove that a deployment occurred.
