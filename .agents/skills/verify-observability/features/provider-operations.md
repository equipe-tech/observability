# Provider operations

## Sub-features

- `auth-login` validates Axiom and Sentry administrator credentials.
- `auth-token-env` validates non-interactive token input before provider access or credential writes.
- `auth-storage` keeps credentials under owner-only permissions.
- `environment-provision` creates isolated non-production provider resources.
- `environment-export` reads deploy variables after required manual work.
- `ops-plan` reads provider state and writes a digest-scoped local plan.
- `ops-apply` reconciles an exact digest-scoped plan.
- `ops-verify` detects drift, unresolved mutations, and pending manual actions.

## How to get to it (user POV)

- Run `observability auth login axiom --organization-id <id>`.
- Run `observability auth login sentry --organization <slug> --team <slug>`.
- Run `observability auth login axiom --organization-id <id> --token-env <variable>`.
- Run `observability auth login sentry --organization <slug> --team <slug> --token-env <variable>`.
- Run `observability provision --dir <project> --name <name> --environment <environment>`.
- Run `observability env list --name <name>`.
- Run `observability env export --name <name> --environment <environment> --release <release>`.
- Run `observability ops plan --dir <project> --environment <environment>`.
- Run `observability ops apply --dir <project> --environment <environment> --plan <file>`.
- Run `observability ops verify --dir <project> --environment <environment>`.

## Driving it with verify-observability

1. Create a fresh `STATE_ROOT` and disposable `PROJECT_ROOT`.
2. With a fresh isolated state for each case, run `auth login axiom --organization-id verification --token-env VERIFY_TOKEN` with `VERIFY_TOKEN` absent, empty, and containing a control character.
3. Require exit code `1`, `OBS_CLI_AUTH_TOKEN_INPUT_INVALID`, no provider request, and no credentials file for every case.
4. Repeat one absent-variable case for Sentry with `auth login sentry --organization verification --team verification --token-env VERIFY_TOKEN`.
5. Require dedicated non-production Axiom and Sentry organizations before positive authentication.
6. Require dedicated short-retention datasets and projects.
7. Drive each protected login prompt through a PTY.
8. Wait for the exact prompt before secret input.
9. Exercise each valid `--token-env` login without exposing its value.
10. Keep tokens outside transcripts and process arguments.
11. Require successful provider identity output.
12. Require `0700` state directories and `0600` credential files.
13. Provision one unique environment and service name under `PROJECT_ROOT` with an explicit Axiom edge deployment.
14. Save any required Correlation action and create that group in the non-production Axiom console.
15. Repeat the identical provision command with `--correlation-confirmed` and the same `--axiom-edge-deployment`.
16. Run `env list --name <name>` and inspect provider state through a second provider view.
17. After correlation confirmation succeeds, run `env export --name <name> --environment <environment> --release <release>` without recording secrets.
18. Copy `observability/operations.yaml` and `observability/contract.json` into `PROJECT_ROOT/observability`.
19. Keep every managed query inline in its operations manifest field.
20. Generate an operations plan for the exact environment.
21. Require the local plan file, mode `0600`, and the reported digest.
22. Verify that provider state remains unchanged after the plan.
23. Apply the exact saved plan.
24. Read every changed resource through a second provider request.
25. If a manual action remains, save its identifier and complete it in the non-production provider console.
26. Generate and save a new plan after the provider-side action.
27. Confirm each completed action with `ops apply --plan <new-file> --confirm-manual <id>` and the same environment.
28. Run `ops verify` only after every required manual confirmation.
29. Generate a final plan and require no provider changes.
30. Retain redacted evidence and remove local state.

Use [`docs/operations-manifest.md`](../../../../docs/operations-manifest.md) for the required manifest, contract, and inline query schemas.

## Gotchas

- Negative `--token-env` validation requires no provider credentials.
- Positive provider verification is blocked without dedicated verification credentials.
- The CLI cannot delete every remote resource that it creates.
- Cleanup must follow the provider account retention policy.
- Never use production organizations, projects, datasets, or tokens.
- Never pass tokens as arguments or write them into evidence.
- `ops plan` performs provider reads and writes `.observability/plan-<digest>.json` locally.
- Destructive apply requires the exact plan digest and explicit authorization.
- `ops verify` fails while a current manual action remains pending.
- A copied credentials file does not prove valid authentication.
