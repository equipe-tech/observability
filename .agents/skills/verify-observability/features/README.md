# Observability verification map

This directory defines the maintained user paths for the Observability CLI and telemetry pipeline.

## Baseline preconditions

- Run commands from the repository root in Bash.
- Build the CLI through the parent skill.
- Use the disposable `STATE_ROOT` from the parent skill.
- Keep evidence in `.verification/observability/$RUN_ID`.
- Refuse to drive a local stack that this run did not start.
- Keep production credentials out of local recipes.

## Drive conventions

- Start each recipe from its listed preconditions.
- Drive the CLI through `bun "$CLI"`.
- Set `OBSERVABILITY_HOME="$STATE_ROOT"` for CLI state.
- Use one local stack at a time because its ports and Compose project name are fixed.
- Record each command, stdout, stderr, and exit code.
- Read generated files or exported telemetry after each write.
- Run cleanup after success and after each failed attempt.

## Proof and skip reports

- Capture the user action and its observable result.
- Keep proof artifacts after cleanup.
- Report the exact precondition that blocks a path.
- Do not substitute unit tests for a listed CLI or pipeline entry point.
- Do not report remote resources without dedicated verification accounts.
- Do not report the deployed canary without dedicated Axiom datasets.

## Feature entry contract

Each feature file contains exactly four H2 sections in this order.

1. `Sub-features` names the supported behavior.
2. `How to get to it (user POV)` lists each user entry point.
3. `Driving it with verify-observability` gives exact commands and observable results.
4. `Gotchas` names conditions that can invalidate a run.

## Features

- [Project asset setup](./project-provisioning.md) covers creation, idempotency, conflict protection, and forced replacement.
- [Local stack lifecycle](./local-stack-lifecycle.md) covers launch, status, viewer readiness, and teardown.
- [Pipeline canary](./pipeline-canary.md) covers traces, logs, metrics, browser events, and redaction.
- [Provider authentication](./provider-authentication.md) covers protected login prompts, credential permissions, and provider status.
- [Package delivery](./package-delivery.md) covers package files, imports, declarations, CLI help, and packaged assets.

Remote environment creation is not a disposable recipe. The CLI has no command that deletes provider resources.
