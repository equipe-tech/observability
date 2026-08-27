# @equipe-tech/observability-cli

CLI da plataforma de observabilidade da Equipe Tech para operar a stack local, provisionar assets do Collector e criar ambientes remotos isolados.

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

Consulte a [referência completa da CLI](https://github.com/equipe-tech/observability/blob/master/docs/cli-reference.md) e o [guia operacional do Collector](https://github.com/equipe-tech/observability/blob/master/docs/collector-production-operations.md).

## Licença

Apache-2.0
