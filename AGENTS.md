# Instruções para agentes

## Padrões do projeto

Leia [`docs/coding-standards.md`](docs/coding-standards.md) antes de escrever ou revisar código. Compare o código pronto com esses padrões antes de declarar o trabalho completo.

Leia [`docs/errors.md`](docs/errors.md) antes de adicionar ou mudar erros tipados, mensagens de erro, contratos públicos de erro ou telemetria de falhas.

Leia [`docs/testing.md`](docs/testing.md) antes de adicionar ou mudar comportamento de aplicação, endpoints públicos ou testes.

Leia [`docs/vite-plus.md`](docs/vite-plus.md) antes de mudar scripts, tasks ou a configuração do workspace.

## Regras gerais

- Nunca use o travessão "—". Use o hífen "-".
- Não escreva comentários em código, exceto quando o pedido incluir a frase exata "add comments".
- Não adicione o nome do agente como coautor em mensagens de commit.

<!-- agent-repos:start -->

## Repositórios vendorados

Este projeto vendora repositórios externos em `repos/` como material de referência para agentes. O diretório está no `.gitignore`. Execute `bun repos:sync` para clonar ou atualizar os repositórios nas versões pinadas em `repos.json`.

- Use os repositórios vendorados somente como referência de leitura.
- Prefira exemplos e padrões do código vendorado a suposições ou resultados de busca na web.
- Não edite arquivos em `repos/` exceto com pedido explícito.
- Não importe de `repos/`; o código da aplicação importa das dependências normais de pacote.

Repositórios disponíveis:

- `repos/effect/` - https://github.com/Effect-TS/effect.git (`effect@4.0.0-rc.111`)

Ao trabalhar com uma biblioteca vendorada, inspecione o repositório correspondente para uso idiomático, testes, estrutura de módulos e design de API. Se o repositório contém orientação para agentes como `LLMS.md`, `AGENTS.md` ou `AGENT.md`, leia essa orientação antes de fazer mudanças. Antes de escrever código Effect, leia `repos/effect/LLMS.md` quando existir.
<!-- agent-repos:end -->
