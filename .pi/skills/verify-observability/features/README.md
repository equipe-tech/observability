# Observability verification map

This directory defines the maintained user-facing verification paths for the observability CLI and telemetry pipeline.

## Baseline preconditions

- Run commands from the repository root in Bash.
- Use the disposable `STATE_ROOT` from the parent skill.
- Keep evidence in `.verification/observability/$RUN_ID`.
- Require Bun 1.4 or later.
- Require Docker for stack and pipeline features.
- Refuse to drive a stack that this run did not start.
- Keep Axiom and Sentry credentials out of local verification.

## Drive conventions

- Start each recipe from its listed preconditions.
- Drive the CLI through `bun packages/cli/src/main.ts`.
- Use `OBSERVABILITY_HOME="$STATE_ROOT"` for CLI state.
- Use one Compose project at a time because the project name and ports are fixed.
- Record each command, stdout, stderr, and exit code.
- Read generated files or exported telemetry after each write.
- Run cleanup after success and after each failed attempt.

## Proof and skip reports

- Capture the user action and its observable result.
- Keep proof artifacts after cleanup.
- Report Docker, port, credential, and network preconditions that block a path.
- Do not substitute unit tests for a listed CLI or pipeline entry point.
- Do not report the deployed canary as verified without dedicated Axiom datasets.

## Feature entry contract

Each feature file contains exactly four H2 sections in this order:

1. `Sub-features` names the supported behavior.
2. `How to get to it (user POV)` lists each user entry point.
3. `Driving it with verify-observability` gives exact commands and observable results.
4. `Gotchas` names conditions that can invalidate a run.

## Features

- [Local stack lifecycle](./local-stack-lifecycle.md) covers isolated launch, status, viewer readiness, and teardown.
- [Pipeline canary](./pipeline-canary.md) covers correlated traces, logs, metrics, and browser events.
- [Sensitive-data redaction](./sensitive-data-redaction.md) covers blocked fields, blocked values, and preserved controls.
- [Project asset setup](./project-provisioning.md) covers asset creation, idempotency, conflict protection, and forced replacement.
- [Package delivery](./package-delivery.md) covers packed files, external imports, declarations, CLI help, and local asset setup.
