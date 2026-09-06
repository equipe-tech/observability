# Setup and release

## Sub-features

- `setup-plan` renders the selected profile without writes.
- `setup-write` writes only the declared target files.
- `setup-verify` checks the saved setup and provider prerequisites.
- `setup-verify-release` checks the application build and release artifacts.

## How to get to it (user POV)

- Run `observability setup plan --dir <application> --profile <profile>`.
- Run `observability setup write --dir <application> --profile <profile>` with the required profile inputs.
- Run `observability setup verify --dir <application>`.
- For React defect releases, run `observability setup verify-release --dir <application>`.

## Driving it with verify-observability

1. Create a disposable application under `STATE_ROOT`.
2. Run `setup plan` with every required profile input.
3. Require exit code `0` and capture the planned file list.
4. Run `setup write` with the same inputs.
5. Read every generated file from the disposable application.
6. Run the same write and require byte-stable output.
7. Run `setup verify` and record each prerequisite result.
8. For a React defect profile, install declared dependencies without scripts.
9. Run the declared application build.
10. Run `setup verify-release` and record each release prerequisite result.
11. Exercise one malformed input and each changed typed error contract.
12. Verify that failed input does not create credentials or unknown files.

Use [`docs/setup-release.md`](../../../../docs/setup-release.md) for the current release declarations and limits.

## Gotchas

- Provider verification requires dedicated credentials and can change remote state.
- Release verification checks artifact structure, not source-map mapping correctness.
- `setup write --force` can replace known generated files.
- Use a disposable application. Never target an existing user project.
