---
name: setup-observability
description: Assemble an application from one official observability profile (nestjs-api, worker, react-web, cli, library). Installs only the required platform packages and generates application-owned composition, contracts, policy, operations, topology, and release gates. Use when onboarding an application or adding observability setup.
disable-model-invocation: true
---

# Setup observability

Use the packaged `observability setup` command. Read [profiles.md](profiles.md), [layout.md](layout.md), and [verification.md](verification.md) before writing.

## Launch

Build the platform CLI when running from this repository. In an application, invoke the installed CLI binary.

```bash
bun run build
export OBSERVABILITY_CLI="$PWD/packages/cli/dist/main.js"
```

## Doctor

```bash
bun "$OBSERVABILITY_CLI" setup --help
bun "$OBSERVABILITY_CLI" setup plan --help
bun "$OBSERVABILITY_CLI" setup write --help
bun "$OBSERVABILITY_CLI" setup verify --help
```

Select the profile explicitly. Collect application-owned service identity, environments, OTLP endpoint, public origin, proxy policy, ingestion path, secret variable names, Sentry source-map coordinates, and pipeline format. Never accept a secret value.

## Drive

Plan first. Plan writes nothing and performs no provider read or mutation.

```bash
bun "$OBSERVABILITY_CLI" setup plan --dir <application> --profile <profile> <application-inputs>
```

Review every `create`, `unchanged`, `preserved`, `updated`, or `conflict` action. Then request explicit filesystem writes.

```bash
bun "$OBSERVABILITY_CLI" setup write --dir <application> --profile <profile> <application-inputs>
```

`--force` may replace only a changed skill-owned file. It never replaces user-preserved or unknown files. Any unapproved conflict blocks all writes.

Verify local composition explicitly.

```bash
bun "$OBSERVABILITY_CLI" setup verify --dir <application> --reconcile --conform --json
```

`--reconcile` regenerates `observability/contract.json`. `--conform` executes the generated composition against the public `runConformance` API. Missing application owner evidence fails. Provider, published-route, and Sentry checks report `blocked` unless their application release transports run them.

## Effects

| Command                                 | Filesystem                                             | Provider reads | Provider mutations |
| --------------------------------------- | ------------------------------------------------------ | -------------- | ------------------ |
| `setup plan`                            | none                                                   | none           | none               |
| `setup write`                           | application composition and `observability/setup.json` | none           | none               |
| `setup verify`                          | none                                                   | none           | none               |
| `setup verify --reconcile`              | regenerates `observability/contract.json`              | none           | none               |
| `observability ops verify`              | none                                                   | explicit       | none               |
| `observability ops apply`               | writes local state                                     | explicit       | explicit           |
| `observability provision --environment` | writes local state                                     | explicit       | explicit           |

Stop before the last two commands. Setup never runs them. Do not load provider credentials during setup.

## Evidence

Capture the exact CLI version, command, stdout, stderr, exit code, generated file digests, and second-run actions. Keep deployed checks separate from local results. `blocked` and `not-applicable` are not successes.

Release only when the generated conformance and every applicable local, production, browser-route, and Sentry canary exits successfully. Keep canary transports application-owned. Never replace an owner receipt with a boolean.

## Cleanup

Remove only the disposable target created by the current run. Keep verification evidence. Never remove application files from a real target.
