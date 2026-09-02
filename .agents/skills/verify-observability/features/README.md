# Observability verification map

This map defines the maintained user paths for the Observability CLI and telemetry pipeline.

## Baseline preconditions

- Run commands from the repository root in Bash.
- Build the CLI through the parent skill.
- Use the disposable `STATE_ROOT` from the parent skill.
- Keep evidence in `.verification/observability/$RUN_ID`.
- Refuse a local stack that this run did not start.
- Keep production credentials out of local recipes.

## Drive conventions

- Start each recipe from its listed preconditions.
- Drive the CLI through `bun "$CLI"`.
- Set `OBSERVABILITY_HOME="$STATE_ROOT"` for CLI state.
- Record each command, stdout, stderr, and exit code.
- Verify each write through files, status, telemetry, or provider reads.
- Run cleanup after success and after each failed attempt.

## Proof and blocked reports

- Capture the user action and its observable result.
- Keep proof artifacts after cleanup.
- Report the exact precondition that blocks a path.
- Do not substitute unit tests for a listed entry point.
- Do not report remote resources without dedicated verification accounts.
- Do not report the deployed canary without dedicated Axiom datasets.

## Features

- [Project provisioning](./project-provisioning.md) covers asset creation, idempotency, conflict protection, and forced replacement.
- [Local pipeline](./local-pipeline.md) covers stack control, viewer readiness, telemetry export, correlation, and redaction.
- [Provider operations](./provider-operations.md) covers authentication, remote environments, operations plans, apply, verify, and manual actions.
- [Production recovery](./production-recovery.md) covers persistent queues, restart, drain, saturation, health, and internal metrics.
- [Package delivery](./package-delivery.md) covers archives, imports, declarations, the CLI binary, assets, and compatibility gates.
