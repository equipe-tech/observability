# Package delivery

## Sub-features

- `package-files` includes required runtime files and excludes source and tests.
- `package-imports` loads the consumer entry points covered by the smoke script.
- `package-types` checks generated declarations from an external project.
- `package-runtimes` exercises supported Bun and Node consumers.
- `package-cli` executes the packed CLI binary and query entry point.
- `package-assets` verifies local and production files from the packed CLI.

## How to get to it (user POV)

- Run `bun run test:package` from the repository root.
- Inspect the command result for the first failed package operation.

## Driving it with verify-observability

1. Require installed Bun dependencies.
2. Require Docker for packed CLI status checks.
3. Create `ARTIFACT_ROOT/package-delivery`.
4. Run `bun run test:package` and save all output.
5. Require exit code `0`.
6. Require the smoke script to reject source and test files in archives.
7. Require the tested external consumer imports to succeed.
8. Require the external TypeScript compiler to accept declarations.
9. Require supported Bun and Node consumers to run.
10. Require the packed CLI to print help.
11. Require the packed CLI to prepare versioned local stack files.
12. Require provisioned Collector and Kamal assets in disposable state.
13. Confirm that no publish, tag, release, or registry mutation occurred.
14. Keep the command, output, exit code, and build revision.

## Gotchas

- The smoke test builds packages and removes its temporary consumer before exit.
- The smoke test does not retain archive listings.
- The smoke test does not publish packages.
- Docker must run even when the smoke test does not start the stack.
- A source import does not replace the packed-package proof.
- Passing tested imports does not prove every package export.
- Release publication requires a separate human gate.
