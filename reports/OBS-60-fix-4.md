# OBS-60 correctness fix 4

## Verified revision

The code revision is `f1d54cabd1d3285454d0357ae266d41fdaf5d3a4`. The worktree was pristine before and after the exact-head matrix, the Linux Collector proof, and the local pipeline canary.

The verification artifacts are in `/tmp/obs60-fix4-f1d54cabd1d3285454d0357ae266d41fdaf5d3a4`.

## Compiled contract provenance

Before the fix, a caller could mutate `eventByAlias.get("SchedulerRun").kind` from `operation` to `domain`. `makeEventProducer` then emitted a domain event with provenance computed from the unchanged operation definition. The complete conformance report returned `conforms: true`.

`defineTelemetryContract` now exposes immutable map views. Compiled event, metric, and audit records are frozen. Nested compiled maps and arrays are also immutable. Every producer lookup therefore uses the same compiled semantics that produced `contract.provenance`.

The regression in `packages/telemetry/test/contract.test.ts` attempts record replacement, index mutation, and nested attribute-map mutation. Each attempt throws `TypeError`. The emitted event remains equal to the frozen definition and retains the contract provenance.

Focused result:

```text
Test Files  1 passed (1)
Tests  46 passed (46)
```

## Local Collector traversal provenance

Before the fix, a worker could send OTLP directly to `destinationEndpoint`. `destinationReceipt` then labeled the downstream capture as `owner-readback`, and the complete report returned `conforms: true` without Collector traversal.

The local helper now gives each Collector instance a private traversal value. The real Collector resource processor writes that value onto traces, logs, and metrics. `telemetry`, `destinationTelemetry`, `awaitDestination`, and `destinationReceipt` read only records with the owning Collector value. Direct downstream sends remain visible to the raw capture server but cannot enter owner-certified evidence.

`packages/telemetry/test/localCollectorTraversal.bun.test.ts` sends one valid OTLP log directly to the downstream receiver and one through the Collector. The direct send produces zero certified logs. The Collector send produces one certified log.

Focused result:

```text
1 pass
0 fail
4 expect() calls
```

The separate Linux Docker-in-Docker proof ran Node on Linux and started the real Collector helper. Its result was:

```json
{
  "platform": "linux",
  "node": "v24.18.1",
  "bypassCertified": false,
  "traversedCertified": true,
  "assessment": "owner-readback",
  "logs": 1
}
```

Deployed evidence remains `application-supplied-readback`. This change does not relabel application evidence as owner evidence and makes no deployed conformance claim.

## Exact-head matrix

Every command ran at `f1d54cabd1d3285454d0357ae266d41fdaf5d3a4` from a pristine worktree.

| Command                              | Exit | Result                                                                                          |
| ------------------------------------ | ---: | ----------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`      |    0 | Lockfile and dependencies accepted.                                                             |
| `bun run check`                      |    0 | 415 files formatted. No warnings, lint errors, or type errors in 325 files.                     |
| `bun run test`                       |    0 | Vite had 586 passed and 3 skipped. Bun had 295 passed, 8 skipped, and 0 failed.                 |
| `bun run build`                      |    0 | All packages built.                                                                             |
| `bun run compat`                     |    0 | Compatibility gate passed.                                                                      |
| `bun run test:conformance`           |    0 | 9 tests passed.                                                                                 |
| `bun run test:package`               |    0 | Package smoke passed.                                                                           |
| Focused compiled-contract regression |    0 | 46 tests passed.                                                                                |
| Focused local Collector regression   |    0 | Direct bypass rejected and Collector traversal accepted.                                        |
| `git diff --check`                   |    0 | No whitespace errors.                                                                           |
| Linux Collector proof                |    0 | Bypass was not certified. Traversal was certified.                                              |
| Local pipeline canary                |    0 | Collector and viewer started, telemetry and redaction passed, and owned resources were removed. |

The matrix preserved the earlier mutation, canonicalization, receipt authenticity, read-back isolation, trace-cycle, evlog, package, and conformance controls through the full suites.

## React limitation

The React prerequisite remains under separate review. This change does not integrate it. The positive React fixture still cannot claim full conformance until owner-verified destination delivery is available for its required traces. This is the known OBS-54 dependency, not an OBS-60 pass.

No external provider operation, deployed canary, credential access, publication, deployment, merge, rebase, retarget, or force-push ran.
