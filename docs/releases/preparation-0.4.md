# Preparação da linha 0.4

A linha 0.4 exige `effect@4.0.1`. A mudança do runtime Effect quebra o contrato de peers de todos os pacotes. Cada pacote mantém publicação e tag independentes.

| Pacote                              | Versão candidata | Motivo                                                  |
| ----------------------------------- | ---------------- | ------------------------------------------------------- |
| `@equipe-tech/observability`        | `0.4.0`          | Peer `effect@~4.0.1` e imports estáveis do Effect 4     |
| `@equipe-tech/observability-effect` | `0.4.0`          | Peer `effect@~4.0.1` e composição com `effect/http`     |
| `@equipe-tech/observability-evlog`  | `0.4.0`          | Peer `effect@~4.0.1`                                    |
| `@equipe-tech/observability-nestjs` | `0.4.0`          | Peer `effect@~4.0.1`                                    |
| `@equipe-tech/observability-sentry` | `0.4.0`          | Peer `effect@~4.0.1`                                    |
| `@equipe-tech/observability-react`  | `0.4.0`          | Peer `effect@~4.0.1`                                    |
| `@equipe-tech/observability-cli`    | `0.4.0`          | Dependências diretas `effect@4.0.1` e `@effect/*@4.0.1` |

Leia [o guia de migração](../migration-0.4.md) antes da atualização. Leia [o runbook de publicação](../release-publication-runbook.md) antes de criar tags.

## Preparar os manifests

A feature não altera versões nem peers entre pacotes do workspace. O commit de preparação da release faz estas mudanças juntas:

1. Grave a versão `0.4.0` em cada manifest listado na tabela.
2. Troque os peers `@equipe-tech/observability@0.3.x` e `@equipe-tech/observability-sentry@0.3.x` por `0.4.x`.
3. Execute `bun install` para atualizar o lockfile.
4. Execute `bun run build`, `bun run compat --release <slug>@0.4.0` e `bun run test:package`.

O smoke de pacotes instala os archives com npm. O npm rejeita peers `0.4.x` enquanto o núcleo ainda declara `0.3.x`. Por isso os passos 1 e 2 pertencem ao mesmo commit.

## Política de alias de ambiente

A linha `0.4.0` mantém `EnvironmentAliasPolicy`. A remoção exige que nenhuma consulta, painel ou alerta use `deployment.environment` durante um período completo de retenção. A preparação da release não comprovou essa condição. [O gerenciamento de ambientes](../environment-management.md) passa a limitar a opção à linha `0.5.0`.

## Publicação

Publique o núcleo antes dos adapters e da CLI. Os consumidores precisam resolver o peer `@equipe-tech/observability@0.4.x`.

Execute `Release Preflight` para cada pacote na revisão aprovada. Crie somente tags independentes, como `observability@0.4.0`, depois do preflight.
