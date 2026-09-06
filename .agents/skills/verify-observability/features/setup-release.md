# Setup and release

## Sub-features

- `setup-plan` renders the selected profile without writes.
- `setup-write` writes only the declared target files.
- `setup-verify-local` reconciles the contract and checks application conformance.
- `setup-verify-deployed` reads provider state for the selected environment.
- `setup-verify-release` checks the application build and release artifacts.

## How to get to it (user POV)

- Run `observability setup plan --dir <application> --profile <profile>` with all required profile inputs.
- Run `observability setup write --dir <application> --profile <profile>` with the same inputs.
- Export the release variable declared in `observability/setup.json`.
- Run `observability setup verify --dir <application> --target local --reconcile --conform --json`.
- Run `observability setup verify --dir <application> --target deployed --environment <environment> --provider-read --json`.
- For React defect releases, run `observability setup verify-release --dir <application>`.

## Driving it with verify-observability

1. Create a disposable application under `STATE_ROOT`.
2. Run `setup plan` with every required profile input.
3. Require exit code `0` and capture the planned file list.
4. Run `setup write` with the same inputs.
5. Read every generated file from the disposable application.
6. Run the same write and require byte-stable output.
7. Read `input.releaseVariable` from `observability/setup.json` and export it with a valid immutable release value.
8. Run local verification with `--target local --reconcile --conform --json`.
9. Parse the JSON report and record each local prerequisite result and filesystem effect.
10. With dedicated credentials, run deployed verification with `--target deployed --environment <environment> --provider-read --json`.
11. Parse the JSON report, record each provider read, and require an empty provider mutation list.
12. For a React defect profile, install declared dependencies without scripts.
13. Run the declared application build.
14. Run `setup verify-release` and record each release prerequisite result.
15. Exercise one malformed input and each changed typed error contract.
16. Verify that failed input does not create credentials or unknown files.

Use [`docs/setup-release.md`](../../../../docs/setup-release.md) for the current release declarations and limits.

## Gotchas

- Deployed verification requires dedicated credentials but performs read-only provider reconciliation.
- Release verification checks artifact structure, not source-map mapping correctness.
- `setup write --force` can replace known generated files.
- Use a disposable application. Never target an existing user project.
