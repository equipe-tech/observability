# Workflow do monorepo com Vite+

O Vite+ é dono das verificações do repositório e da execução de tarefas dos workspaces. O `vite.config.ts` da raiz contém os padrões compartilhados de formatação, lint, type-check e Vite Task. Cada workspace terá seu próprio `vite.config.ts` com o grafo de tarefas do pacote.

## Comandos

```sh
vp check          # lint (type-aware) + format check + type-check
vp check --fix    # aplica as correções
vp test run       # testes
vp fmt --write .  # formata
vp lint .         # somente lint
```

`vp test`, `vp build` e `vp dev` são comandos embutidos. `vp run <task>` executa um script de pacote ou uma Vite Task configurada. Use seletores exatos `pacote#task` para operações de infraestrutura.

## Hooks de git

Os hooks vivem em `.vite-hooks/` e são versionados. O `bun install` executa `vp config --no-agent` e instala o dispatcher. Use `git config --get core.hooksPath` para verificar o caminho ativo.

- `pre-commit` roda `vp staged` (configurado na chave `staged` do `vite.config.ts`).
- `commit-msg` roda o commitlint (conventional commits).

`VP_GIT_HOOKS=0` desabilita os hooks em containers e CI.

## Política de cache das tasks

Scripts de pacote não usam cache. Tasks configuradas usam cache por padrão. Toda task que faz deploy, destrói recursos, sincroniza estado externo ou inicia um processo de longa duração deve declarar `cache: false`.

## Dependências

Com Bun 1.4, o `vp` encaminha comandos de package manager direto ao `bun`: `vp add`, `vp remove`, `vp update` (com `--filter`), `vp dedupe`, `vp pm prune` e `vp pm audit --fix`.

Pins exatos para o toolchain: `vite-plus`, `@oxlint/plugins`, `oxlint` e `effect` não usam ranges.
