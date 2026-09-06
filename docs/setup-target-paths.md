# Setup target paths

## Target identity

`setup plan`, `setup write`, and `setup verify` report the absolute requested directory and the canonical directory used for filesystem operations. Installation uses the canonical directory from the plan and validates it again before starting Bun.

On Darwin, setup recognizes only these system aliases, with these exact relative link destinations:

| Absolute prefix | Required link destination | Canonical prefix |
| --------------- | ------------------------- | ---------------- |
| `/tmp`          | `private/tmp`             | `/private/tmp`   |
| `/var`          | `private/var`             | `/private/var`   |
| `/etc`          | `private/etc`             | `/private/etc`   |

A recognized prefix is converted before validation. The canonical prefix and every existing ancestor are still inspected. No other symlink is followed or accepted as a trusted root. Other platforms use ordinary absolute paths without these exceptions.

## Validation and writes

Setup checks every existing component from the filesystem root through the application root and each generated destination. Missing roots and missing descendants are valid when their existing ancestors are directories without links. Output paths must remain inside the application root.

Symlinked roots, ancestors, output directories, final files, and `observability/setup.json` produce `OBS_SETUP_CONFLICT`. Hard-linked output files are also rejected. Ancestors must be directories and existing output files must be regular files.

Planning validates paths before reading the decision record or classifying files. It creates no directories or files. Writing validates all destinations and the decision record before its first mutation. Each atomic file replacement repeats the path checks before creating directories, after creating directories, and before renaming the temporary file.

Verification validates generated paths before reading or executing application composition. Each verification subprocess repeats the checks. Installation also checks `package.json`, `bun.lock`, `bun.lockb`, and `node_modules`. `setup write --install` checks those destinations before writing application files.

Unknown files remain untouched. `--force` still replaces only recorded skill-owned files. It never bypasses the path policy.

## Decision record

New version 1 records include an optional `target` object with `requestedDirectory` and `directory`. These fields describe the write destination. They do not authorize a future destination or change recorded ownership. Version 1 records without `target` remain readable. Moving a project does not make its old recorded path authoritative.

## Limits

The guarantee covers unsafe paths present during preflight on an ordinary local filesystem. Preflight rejection writes no files. Write-time checks reduce path-replacement exposure but do not provide a descriptor-relative sandbox against a hostile concurrent filesystem actor. An I/O failure or a later path replacement can leave earlier generated files in place.

Application scripts and the package manager retain their normal permissions. Setup does not confine arbitrary code, package lifecycle scripts, mounts, or dependency trees. Provider operations, deployment, and publication are separate from this path policy.
