# Official profiles

The generator derives capability validity from `observabilityProfiles`.

| Profile      | Platform composition        | Optional selections                        |
| ------------ | --------------------------- | ------------------------------------------ |
| `nestjs-api` | core and NestJS             | browser ingest, defects outside production |
| `worker`     | core and evlog              | defects outside production                 |
| `react-web`  | core, React, browser ingest | metrics, defects outside production        |
| `cli`        | core and evlog              | traces, metrics, defects                   |
| `library`    | core contract types only    | none                                       |

Production profiles with `required-in-production` defects require `--with-defects`. React defects also require `--sentry-org` and `--sentry-project` for the owner-planned source-map execution.

The application supplies environment values at runtime. Setup records only variable names. Generated imports use public package entrypoints. Generated files never implement OTLP, Collector, framework, adapter, query, or canary internals.
