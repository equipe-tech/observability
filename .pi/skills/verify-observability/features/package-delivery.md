# Package delivery

The package smoke test verifies the published file set and both packages from a temporary external consumer project.

## Sub-features

- `package-files` includes each required runtime file and excludes source and test files.
- `package-imports` loads every public telemetry entrypoint from an external project.
- `package-types` checks generated declarations through the external TypeScript compiler.
- `package-cli` executes help and status through the packed CLI binary.
- `package-assets` verifies local stack assets and provisioned production assets from the packed CLI.

## How to get to it (user POV)

- Run `bun run test:package` from the repository root.
- Inspect the command output for the first failed package operation.

## Driving it with verify-observability

Preconditions:

- Bun dependencies are installed.
- Docker is available because the packed CLI runs `dev status`.
- `ARTIFACT_ROOT` exists.
- No package publish command runs in this recipe.

- **Build packages.** Run `bun run test:package`. The script builds both package distributions before it creates archives.
- **Verify archives.** Require exit code `0`. The script checks required files and rejects packaged `src` and `test` directories.
- **Verify imports.** Require exit code `0`. The temporary consumer imports each public telemetry entrypoint.
- **Verify declarations.** Require exit code `0`. The external TypeScript compiler checks package declarations without source specifiers.
- **Verify the CLI.** Require exit code `0`. The packed binary prints help, prepares local stack assets, and provisions production assets.
- **Capture proof.** Save the exact command, stdout, stderr, and exit code under `ARTIFACT_ROOT`.

## Gotchas

- The smoke test creates archives and a consumer under a temporary directory. It removes that directory before exit.
- The smoke test does not publish either package.
- Docker must be active even though the smoke test does not start the local stack.
- A successful source import does not replace this proof. The recipe executes the packed artifacts.
