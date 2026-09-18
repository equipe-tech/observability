---
name: deploy-observability
description: Plans and verifies an application observability deployment through provider reconciliation, protected GitHub Environments, application-owned deploys, explicit telemetry rollout, and isolated canaries. Use when preparing, deploying, or rolling out generated observability setup.
disable-model-invocation: true
---

# Deploy observability

The application repository owns its branch, pull request, application deployment, restart, and runtime proof. The CLI owns provider plans, local credential state, and GitHub Environment synchronization. GitHub owns Environment protection enforcement. An approval in one authority never authorizes another.

Never parse `observability env export`; it prints secrets. Never put tokens, DSNs, provider response bodies, or secret-derived values in notes, plans, arguments, logs, or errors.

## 1. Discover and authenticate

From the application root, require an existing `observability/setup.json` and inspect the generated plan before changing it:

```bash
observability setup plan <the same explicit setup flags used by the application>
observability auth status
gh auth status
```

Require `gh auth status` to identify an authenticated principal with read/write access to Environment variables and secrets in the explicit repository. Provider authentication and GitHub authentication are separate authorities.

If authentication is absent, authenticate through environment-backed input, then repeat status:

```bash
observability auth login axiom --organization-id <id> --token-env <safe-env-name>
observability auth login sentry --organization <org> --team <team> --token-env <safe-env-name>
```

Do not continue when setup identity, custom release or Sentry variable names, provider identity, or the target environment is ambiguous.

## 2. Branch, generate, and open a pull request

Create an application-owned branch. Run setup write only with the application's reviewed inputs, inspect every generated diff, and run local checks:

```bash
observability setup write <reviewed setup flags>
observability setup verify --dir . --target local --reconcile --conform --json
```

Commit and publish only when explicitly authorized. Open a pull request through the repository's normal process. Preserve modified or unknown generated destinations under setup conflict rules. A pull request approval authorizes code integration only. It does not authorize provider mutation, deployment, restart, or rollout.

The generated workflow no longer uses a tag trigger. The application-owned deployment must explicitly dispatch `.github/workflows/observability.yml` after it proves that the exact immutable `deployed_ref` is running.

## 3. Choose queue durability

Use `durable` unless the application owner explicitly accepts telemetry loss during process, host, network, or Collector interruption:

```bash
observability ops plan --dir . --environment <environment> --axiom-edge-deployment <edge> --queue-mode durable --json
```

For best effort, both plan and apply require the explicit acceptance flag so the decision is digest-bound:

```bash
observability ops plan --dir . --environment <environment> --axiom-edge-deployment <edge> --queue-mode best-effort --accept-best-effort-data-loss --json
```

## 4. Provision providers from the exact plan

Review the digest and all dataset, ingestion-token, Sentry, retention, Correlation, dashboard, and monitor actions. Apply only the persisted plan:

```bash
observability ops apply \
  --dir . \
  --environment <environment> \
  --axiom-edge-deployment <edge> \
  --queue-mode durable \
  --plan .observability/plan-<digest>.json
```

Use `--allow-destructive` only after separate approval for the exact digest. Never confirm a manual action that was not actually completed.

A cold start must produce the three environment datasets, a least-privilege ingestion token, the canonical Sentry project and client key when enabled, local secure environment credentials, and Collector assets. A token or administrative credential change after planning makes the plan stale. Pending or unknown provider mutations block export and GitHub synchronization.

Correlation remains manual:

1. Open the Axiom Console.
2. Create the exact saved group listed by the plan using its traces, logs, and metrics datasets.
3. Replan.
4. Apply with `--confirm-manual <exact-id>` only after the action is complete.
5. Run `observability ops verify`.

The CLI does not claim remote Correlation read-back. Manual confirmation evidence and the secure managed-environment state are host-local. An isolated CI runner does not inherit either one. Before enabling generated `verify-providers`, set Environment-protected `OBSERVABILITY_MANAGED_ENVIRONMENT_EVIDENCE` to the reviewed credentials document containing managed environments but no administrative credentials, and `OBSERVABILITY_OPERATIONS_EVIDENCE` to the exact approved operations state for the service. The generated workflow restores both with owner-only permissions without logging them. If that evidence is unavailable, the CI provider gate must remain blocked; do not bypass manual actions or interpret a fresh empty state as confirmation.

## 5. Synchronize a protected GitHub Environment

The Environment must already require reviewers, prevent self-review, and restrict deployment branches. It must also contain narrowly scoped CI read credentials named `OBSERVABILITY_AXIOM_AUTH_TOKEN` and, when Sentry is enabled, `SENTRY_AUTH_TOKEN`. These administrative read credentials are not synchronized by `env github`; create them through the provider's minimum read-only policy and the protected Environment's secret-management process. Never copy a personal or broad administrator token merely to make verification pass. Reviewer IDs and branch-policy settings are bound to the plan digest.

Start with rollout disabled:

```bash
observability env github plan \
  --dir . \
  --repo <owner/repository> \
  --name <service> \
  --environment <environment> \
  --release <immutable-version> \
  --rollout disabled

observability env github apply --plan .observability/github-plan-<digest>.json
```

The CLI discovers custom release and Sentry variable names from `observability/setup.json`. It verifies exact variable values and secret metadata presence after writes. Secret equality is never observable. Paginated reads, a repository-and-environment lock, and durable recovery state prevent concurrent or blind retries. Replan after an unknown outcome.

## 6. Deploy and prove the application state

The application-owned deployment contract must map these Environment values into the application runtime:

- variables: service identity, the custom release variable, deployment environment, OTLP endpoint, dataset names, and rollout state;
- secrets: Axiom ingestion token and the custom Sentry DSN variable.

The generated verification workflow maps the same contract into its canary job, but does not deploy or restart the application. A GitHub variable update does not alter a running process.

Use the application's protected deployment workflow to deploy the exact immutable version. Prove the running workload has that identity. Then explicitly dispatch `.github/workflows/observability.yml` with the protected Environment and exact deployed ref. A workflow start, tag, checkout, or source-map upload is not deployment proof.

## 7. Approve rollout, redeploy, and restart

Create a new GitHub plan with `--rollout enabled`. Obtain separate rollout approval for that digest and apply with `--approve-rollout`.

After the variable changes, run a subsequent approved application redeploy or restart so the running process receives the enabled value. Prove the new process identity and effective rollout state. Only then dispatch the generated verification workflow again.

## 8. Verify without production test writes

Run provider read-back and runtime canaries against separately named, isolated non-production test destinations. Never emit verification telemetry into production datasets:

```bash
observability setup verify --dir . --target deployed --environment <test-environment> --provider-read --json
```

Require real receipts for Node or Nest telemetry, browser ingest when applicable, source-map identity, and Sentry read-back. A blocked, skipped, or not-applicable result is not success.

## Recovery and evidence

- Stale plan: discard it and create a fresh plan.
- Unknown provider or GitHub outcome: inspect durable state, read back remote state, replan, and repeat only an idempotent action authorized by the new digest.
- Lost lock owner: prove the process is gone and reconcile durable state before removing the lock.
- Canary failure: stop rollout. Do not weaken protection or mutate production verification destinations.

Capture CLI version, commands, plan digests, non-secret stdout and stderr, Environment name, reviewer and branch-policy scope, immutable deployed ref, separate approval scopes, redeploy or restart receipt, runtime identity proof, isolated canary destination, receipts, and exit codes. State every operation that was not executed or could not be remotely verified.
