# Provider operations

## Sub-features

- `auth-login` validates Axiom and Sentry administrator credentials.
- `auth-storage` keeps credentials under owner-only permissions.
- `environment-provision` creates isolated non-production provider resources.
- `environment-export` reads deploy variables after required manual work.
- `ops-plan` reads desired and provider state without mutations.
- `ops-apply` reconciles an exact digest-scoped plan.
- `ops-verify` detects drift, unresolved mutations, and pending manual actions.

## How to get to it (user POV)

- Run `observability auth login axiom --organization-id <id>`.
- Run `observability auth login sentry --organization <slug> --team <slug>`.
- Run `observability provision --dir <project> --name <name> --environment <name>`.
- Run `observability env list` or `observability env export`.
- Run `observability ops plan --dir <project>`.
- Run `observability ops apply --dir <project> --plan <file>`.
- Run `observability ops verify --dir <project>`.

## Driving it with verify-observability

1. Require dedicated non-production Axiom and Sentry organizations.
2. Require dedicated short-retention datasets and projects.
3. Create a fresh `STATE_ROOT` and disposable project directory.
4. Drive each protected login prompt through a PTY.
5. Wait for the exact prompt before secret input.
6. Keep tokens outside transcripts and process arguments.
7. Require successful provider identity output.
8. Require `0700` state directories and `0600` credential files.
9. Provision one unique environment and service name.
10. Read provider state through `env list` and provider consoles or APIs.
11. Save only resource names, kinds, status, and bounded redacted output.
12. Generate an operations plan.
13. Verify that provider state remains unchanged after the plan.
14. Apply the exact saved plan.
15. Read every changed resource through a second provider request.
16. Generate a second plan and require no changes.
17. Run `ops verify` and require success.
18. If a manual action exists, save it and stop before confirmation.
19. Complete the manual action in the non-production provider console.
20. Confirm it through the documented CLI path.
21. Run `ops verify` again.
22. Retain redacted evidence and remove local state.

## Gotchas

- This recipe is blocked without dedicated verification credentials.
- The CLI cannot delete every remote resource that it creates.
- Cleanup must follow the provider account retention policy.
- Never use production organizations, projects, datasets, or tokens.
- Never pass tokens as arguments or write them into evidence.
- `ops plan` must not mutate providers or local operations state.
- Destructive apply requires the exact plan digest and explicit authorization.
- A copied credentials file does not prove valid authentication.
