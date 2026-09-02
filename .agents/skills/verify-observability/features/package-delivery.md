# Package delivery

## Sub-features

- `package-files` includes each required runtime file and excludes source and tests.
- `package-imports` loads every public entry point outside the repository.
- `package-types` checks generated declarations from an external project.
- `package-runtimes` exercises supported Bun and Node consumers.
- `package-cli` executes the packed CLI binary and query entry point.
- `package-assets` verifies local and production files from the packed CLI.

## How to get to it (user POV)

- Run `bun run build` from the repository root.
- Run `bun run test:package` from the repository root.
- Inspect the command result for the first failed package operation.

## Driving it with verify-observability

1. Require installed Bun dependencies.
2. Require Docker for packed CLI status checks.
3. Create `ARTIFACT_ROOT/package-delivery`.
4. Run `bun run build` and save all output.
5. Run `bun run test:package` and save all output.
6. Require exit code `0` from both commands.
7. Require the smoke script to reject source and test files in archives.
8. Require external imports for every public package entry point.
9. Require the external TypeScript compiler to accept declarations.
10. Require supported Bun and Node consumers to run.
11. Require the packed CLI to print version and help.
12. Require the packed CLI to prepare versioned local stack files.
13. Require provisioned Collector and Kamal assets in disposable state.
14. Confirm that no publish, tag, release, or registry mutation occurred.
15. Keep commands, outputs, exit codes, package lists, and the build revision.

## Gotchas

- The smoke test removes its temporary consumer before exit.
- The smoke test does not publish packages.
- Docker must run even when the smoke test does not start the stack.
- A source import does not replace the packed-package proof.
- A successful build does not prove package exports or runtime entry points.
- Release publication requires a separate human gate.
