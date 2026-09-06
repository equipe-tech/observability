# Preparação da linha 0.3

Esta preparação cobre os seis pacotes alterados pelo stack. Cada pacote mantém publicação e tag independentes.

| Pacote                              | Versão candidata | Motivo                                                                 |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `@equipe-tech/observability`        | `0.3.4`          | Contratos tipados, identidade canônica, política, métricas e auditoria |
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

Execute `Release Preflight` para cada pacote na revisão aprovada. Crie somente tags independentes, como `observability@0.3.4`, depois do preflight.

Mantenha a aprovação humana do environment `publication`. O push da tag solicita somente a verificação protegida. A publicação exige outro `workflow_dispatch`, com `tag` e `confirm_tag` idênticos.

## Recuperação da primeira tentativa

A tag `observability@0.3.0` registra uma tentativa sem publicação no npm. O canário protegido falhou ao resolver o secret de ingestão no workflow reutilizável. Preserve essa tag para diagnóstico.

A tentativa `observability@0.3.1` resolveu os secrets no job direto, mas o Collector encerrou por falta de permissão no diretório da fila. Preserve também essa tag sem publicação.

A tentativa `observability@0.3.2` iniciou o Collector, mas a consulta APL usou uma rota global indisponível no endpoint regional.

A tentativa `observability@0.3.3` alcançou a API regional, mas consultou logs com caminhos de campos exclusivos de traces. O preflight protegido em `master` confirmou os schemas sem criar outra tag.

A recuperação prepara `observability@0.3.4`, com consultas separadas para os schemas reais de traces e logs. O canário preserva as verificações de identidade, correlação e redaction. Crie a tag somente depois do preflight protegido bem-sucedido. Os outros cinco pacotes mantêm `0.3.0`, pois suas tags ainda não foram criadas.

Os cadastros dos dois secrets Axiom e das cinco variables existem no environment `publication`. As regras permitem as tags dos seis slugs. O `NPM_TOKEN` existe no escopo do repositório.

A existência desses cadastros não comprova autenticação ou entrega de telemetria. A publicação continua condicionada ao canário deployed e à aprovação humana.
