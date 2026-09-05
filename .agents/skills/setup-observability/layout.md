# Generated layout

| Path                                  | Ownership                                      |
| ------------------------------------- | ---------------------------------------------- |
| `observability/setup.json`            | skill decision record                          |
| `observability/dependencies.json`     | skill-owned dependency declaration             |
| `observability/contract.ts`           | user-preserved contract extension              |
| `observability/contract-index.ts`     | user-preserved contract writer composition     |
| `observability/contract.json`         | explicit reconciliation output                 |
| `observability/policy.ts`             | user-preserved policy extension                |
| `observability/operations.yaml`       | user-preserved operations declaration          |
| `observability/topology.json`         | user-preserved topology declaration            |
| `observability/environment.json`      | user-preserved variable-name declaration       |
| `observability/conformance.target.ts` | user-preserved owner evidence composition      |
| `observability/conformance.ts`        | skill-owned public conformance runner          |
| `src/observability/bootstrap.ts`      | user-preserved public runtime composition      |
| `observability/canary.ts`             | skill-owned owner-canary invocation            |
| `observability/source-maps.ts`        | skill-owned Sentry source-map plan composition |
| `.github/workflows/observability.yml` | skill-owned blocking release wiring            |

Setup compares content before any write. Unknown files conflict. Modified user-preserved files remain unchanged. Modified skill-owned files conflict unless `--force` is explicit. All conflicts are detected before filesystem writes.
