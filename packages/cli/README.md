# @equipe-tech/observability-cli

CLI da plataforma de observabilidade da Equipe Tech para operar a stack local, provisionar assets do Collector e criar ambientes remotos isolados.

## Requisito de runtime

A CLI exige Bun 1.4 ou posterior. O executável publicado usa `#!/usr/bin/env bun`; instalar o pacote com npm não substitui esse requisito.

## Instalação

```sh
npm install --global @equipe-tech/observability-cli
observability --help
```

Também pode ser executada sem instalação global:

```sh
npx @equipe-tech/observability-cli --help
```

## Capacidades

- `observability dev up|status|down` opera o Collector e o viewer locais.
- `observability provision` gera a configuração de produção do Collector e o accessory Kamal.
- Os comandos de autenticação e ambiente provisionam recursos específicos de Axiom e Sentry e armazenam credenciais locais com modo restrito.
- Os assets de produção incluem filas persistentes limitadas, retry, health check, métricas internas, normalização de ambiente e redação de dados sensíveis.

A stack local usa um diretório por versão em `OBSERVABILITY_HOME`, cujo padrão é `~/.local/state/observability`. A atualização para 0.2.0 muda o diretório ativo de `0.1.0` para `0.2.0`. Derrube a stack antiga com a CLI 0.1.0 antes de atualizar; a CLI 0.2.0 não reutiliza nem remove automaticamente o diretório anterior.

A dependência direta `@effect/platform-node-shared@4.0.0-rc.111` impede que instaladores npm selecionem uma release candidate posterior incompatível com `@effect/platform-bun@4.0.0-rc.111`. Remova o pin somente quando todo o conjunto Effect for atualizado e validado em conjunto.

Consulte a [referência completa da CLI](https://github.com/equipe-tech/observability/blob/master/docs/cli-reference.md) e o [guia operacional do Collector](https://github.com/equipe-tech/observability/blob/master/docs/collector-production-operations.md).

## Licença

Apache-2.0
