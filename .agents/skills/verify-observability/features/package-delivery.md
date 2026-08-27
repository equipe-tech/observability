# Package delivery

The package smoke test verifies the published file set from a temporary external consumer project.

## Sub-features

- `package-files` includes each required runtime file and excludes source and test files.
- `package-imports` loads every public telemetry entrypoint outside the repository.
- `package-types` checks generated declarations through the external TypeScript compiler.
- `package-cli` executes help and status through the packed CLI binary.
- `package-assets` verifies local and production files from the packed CLI.

## How to get to it (user POV)

- Run `bun run test:package` from the repository root.
- Inspect the command result for the first failed package operation.

## Driving it with verify-observability

Preconditions:

- Bun dependencies are installed.
- Docker is available because the packed CLI runs `dev status`.
- `ARTIFACT_ROOT` exists.
- No package publish command runs in this recipe.

- **Run the package proof.** Run `bun run test:package`. The script builds both package distributions.
- **Verify archives.** Require exit code `0`. The script checks required files and rejects `src` and `test` directories.
- **Verify imports.** Require exit code `0`. The temporary consumer imports each public telemetry entrypoint.
- **Verify declarations.** Require exit code `0`. The external TypeScript compiler checks the package declarations.
- **Verify the CLI.** Require exit code `0`. The packed binary prints help and prepares local stack files.
- **Verify production files.** Require exit code `0`. The packed binary writes Collector and Kamal files into disposable state.
- **Capture proof.** Save the exact command, stdout, stderr, and exit code under `ARTIFACT_ROOT/package-delivery`.

## Gotchas

- The smoke test removes its temporary consumer before exit.
- The smoke test does not publish either package.
- Docker must run even though the smoke test does not start the local stack.
- A source import does not replace this package proof.
