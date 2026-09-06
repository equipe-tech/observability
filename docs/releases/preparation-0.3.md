# Preparação da linha 0.3

Esta preparação cobre os seis pacotes alterados pelo stack. Cada pacote mantém publicação e tag independentes.

| Pacote                              | Versão candidata | Motivo                                                                 |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `@equipe-tech/observability`        | `0.3.0`          | Contratos tipados, identidade canônica, política, métricas e auditoria |
| `@equipe-tech/observability-evlog`  | `0.3.0`          | Primeiro release do adapter oficial de eventos                         |
| `@equipe-tech/observability-nestjs` | `0.3.0`          | Primeiro release da integração extraída do núcleo                      |
| `@equipe-tech/observability-sentry` | `0.3.0`          | Primeiro release dos adapters de defeitos Node e browser               |
| `@equipe-tech/observability-react`  | `0.3.0`          | Primeiro release da integração React                                   |
| `@equipe-tech/observability-cli`    | `0.3.0`          | Setup, manifestos, operações e mudanças incompatíveis documentadas     |

A CLI publicada permanece em `0.2.1`. A candidata exige `0.3.0`, conforme o registro de compatibilidade e o guia de migração.

## Changelog e migração

`CHANGELOG.md` e as notas individuais em `docs/releases/` usam `scripts/release-notes.ts`. Não edite os arquivos gerados manualmente.

Leia [o guia de migração](../migration-0.3.md) antes da atualização. Leia [o runbook de publicação](../release-publication-runbook.md) antes de criar tags.

## Publicação posterior

Publique o núcleo antes dos adapters e da CLI, pois os consumidores precisam resolver o peer `@equipe-tech/observability@0.3.x`.

Execute `Release Preflight` para cada pacote na revisão aprovada. Crie somente tags independentes, como `observability@0.3.0`, depois do preflight.

Mantenha a aprovação humana do environment `publication`. O push da tag solicita somente a verificação protegida. A publicação exige outro `workflow_dispatch`, com `tag` e `confirm_tag` idênticos.

## Pendências externas

A inspeção do environment `publication` identificou estas pendências:

- A política permite somente tags `v*`. Ela não permite as tags independentes `<slug>@<versão>`.
- Os secrets `AXIOM_INGEST_TOKEN`, `AXIOM_READ_TOKEN` e `NPM_TOKEN` não estão configurados nesse environment.
- As variables `AXIOM_ORGANIZATION_ID`, `AXIOM_URL`, `AXIOM_DATASET_TRACES`, `AXIOM_DATASET_LOGS` e `AXIOM_DATASET_METRICS` não estão configuradas.

Configure credenciais restritas aos datasets E2E. Permita as tags dos seis slugs sem remover a aprovação humana.

Esta preparação não publica tags, GitHub Releases ou pacotes npm. A aceitação deployed permanece pendente até a configuração e aprovação do environment.
