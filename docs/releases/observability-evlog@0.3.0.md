## observability-evlog@0.3.0

### Novidades

- feat(setup): prepare release prerequisites (OBS-58) (#77)
- feat(testing): ship reusable platform conformance suite (OBS-60) (#76)
- feat(nestjs): add one correlated defect boundary (#75)
- feat(compat): enforce contract and package compatibility gates (#73)
- feat(cli): add operations manifest workflow (#71)
- feat(audit): add shared audit publication contracts (#70)
- feat(react): add browser observability adapter (#69)
- feat(sentry): add Node and browser defect adapters (#68)
- feat(metrics): add contract-bound metric definitions (#67)
- feat(evlog): add the official bounded OTLP adapter (#66)
- feat: split observability package boundaries (#65)
- feat(telemetry): enforce data policy before buffering (#64)
- feat(telemetry): add profile lifecycle contracts (#63)
- feat(telemetry): enforce canonical identity and correlation (#61)
- feat(telemetry): publish typed telemetry contracts (#60)
- feat(telemetry): correlate evlog request events (#17)
- feat(telemetry): add lifecycle-safe NestJS module (#16)
- feat(telemetry): add framework-neutral metrics facade (#15)
- feat(telemetry): add framework-neutral browser client (#14)
- feat(cli): support provider-specific remote provisioning (#12)
- feat(telemetry): complete NestJS HTTP span semantics (#10)
- feat(collector): normalize deployment environment attributes (#9)
- feat: add observability verification skill (#6)
- feat(lint): strengthen anti-slop rules (#3)
- feat(lint): adopt effect and hygiene oxlint rules (#2)
- feat: provision remote observability environments (#1)
- feat: add the tag-driven release pipeline
- feat: ship the /_telemetry/events endpoint in the nestjs adapter
- feat: provision production collector assets from the cli
- feat: add node, nestjs, browser and testing runtime adapters
- feat: build pipeline, embedded stack assets and CI workflow
- feat: implement telemetry package, cli and local collector stack

### Correções

- fix(release): resolve protected secrets in native jobs
- fix: resolve stack review findings (#78)
- fix(cli): accept Axiom default retention payloads (#24)
- fix(cli): create MetricsDB datasets and correlation gates (#22)
- fix(cli): synchronize Collector cleanup signals (#20)
- fix(collector): bound persistent queues and recovery operations (#13)
- fix(telemetry): redact browser events before transport (#11)
- fix(telemetry): propagate NestJS trace context (#8)
- fix(collector): redact sensitive telemetry fields (#4)
- fix: publish npm tarballs with an explicit relative path
- fix: make the local stack data directory writable by the collector container
- fix: print docker compose output when a stack command fails
- fix: use a step env for the observability state directory in ci

### Outras mudanças

- chore: prepare independent 0.3.0 releases (#81)
- ci(release): restore the scoped provider canary (#74)
- chore(release): prepare v0.2.0 packages (#18)
- chore: update pstack model routing
- chore: update agent configuration
- test: add the deployed acceptance canary against axiom
- chore: bootstrap toolchain with vite-plus 0.3.0, bun 1.4, effect v4 and agent tooling
- docs: drop ownership mode, credentials and endpoints define ownership
- chore: bootstrap repository with README and license
