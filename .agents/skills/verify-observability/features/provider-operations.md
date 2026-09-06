# Provider operations

## Sub-features

- `auth-login` validates Axiom and Sentry administrator credentials.
- `auth-storage` keeps credentials under owner-only permissions.
- `environment-provision` creates isolated non-production provider resources.
- `environment-export` reads deploy variables after required manual work.
- `ops-plan` reads provider state and writes a digest-scoped local plan.
- `ops-apply` reconciles an exact digest-scoped plan.
- `ops-verify` detects drift, unresolved mutations, and pending manual actions.

## How to get to it (user POV)

- Run `observability auth login axiom --organization-id <id>`.
- Run `observability auth login sentry --organization <slug> --team <slug>`.
- Run `observability provision --dir <project> --name <name> --environment <environment>`.
- Run `observability env list --name <name>`.
- Run `observability env export --name <name> --environment <environment> --release <release>`.
- Run `observability ops plan --dir <project> --environment <environment>`.
- Run `observability ops apply --dir <project> --environment <environment> --plan <file>`.
- Run `observability ops verify --dir <project> --environment <environment>`.

## Driving it with verify-observability

1. Require dedicated non-production Axiom and Sentry organizations.
2. Require dedicated short-retention datasets and projects.
3. Create a fresh `STATE_ROOT` and disposable `PROJECT_ROOT`.
4. Drive each protected login prompt through a PTY.
5. Wait for the exact prompt before secret input.
6. Keep tokens outside transcripts and process arguments.
7. Require successful provider identity output.
8. Require `0700` state directories and `0600` credential files.
9. Provision one unique environment and service name under `PROJECT_ROOT`.
10. Run `env list --name <name>` and inspect provider state through a second provider view.
11. Run `env export --name <name> --environment <environment> --release <release>` without recording secret values.
12. Copy `observability/operations.yaml`, `observability/contract.json`, and required query files into `PROJECT_ROOT/observability`.
13. Generate an operations plan for the exact environment.
14. Require the local plan file, mode `0600`, and the reported digest.
15. Verify that provider state remains unchanged after the plan.
16. Apply the exact saved plan.
17. Read every changed resource through a second provider request.
18. If the plan contains a manual action, save its identifier and complete it in the non-production provider console.
19. Confirm each completed action with `ops apply --plan <file> --confirm-manual <id>` and the same environment.
20. Run `ops verify` only after every required manual confirmation.
21. Generate a second plan and require no provider changes.
22. Retain redacted evidence and remove local state.

Use [`docs/operations-manifest.md`](../../../../docs/operations-manifest.md) for the required manifest, contract, and query schemas.

## Gotchas

- This recipe is blocked without dedicated verification credentials.
- The CLI cannot delete every remote resource that it creates.
- Cleanup must follow the provider account retention policy.
- Never use production organizations, projects, datasets, or tokens.
- Never pass tokens as arguments or write them into evidence.
- `ops plan` performs provider reads and writes `.observability/plan-<digest>.json` locally.
- Destructive apply requires the exact plan digest and explicit authorization.
- `ops verify` fails while a current manual action remains pending.
- A copied credentials file does not prove valid authentication.
