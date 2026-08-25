# Ambientes isolam dados sem acoplar a aplicação

O pacote trata o ambiente como um atributo OpenTelemetry. `OTEL_DEPLOYMENT_ENVIRONMENT` identifica `development`, `staging`, `production`, ou outro ambiente.

A aplicação envia os três sinais para um Collector. Ela não contém credenciais do Axiom e não conhece os nomes dos datasets.

## O ambiente local não usa contas externas

O ambiente local usa `http://localhost:4318` como endpoint padrão. O Collector local envia os sinais para o `otel-desktop-viewer`.

Esse fluxo mantém o Collector entre a aplicação e o destino. O mesmo contrato OTLP existe no ambiente local e nos ambientes remotos.

## Cada ambiente remoto tem recursos isolados no Axiom

A CLI cria três datasets para cada ambiente:

- `<project>-<environment>-traces`
- `<project>-<environment>-logs`
- `<project>-<environment>-metrics`

A CLI também cria um token de ingestão para cada ambiente. O token concede acesso somente aos três datasets daquele ambiente.

Esse isolamento permite retenções e permissões diferentes. Uma credencial de `staging` não concede acesso aos dados de `production`.

## Um projeto Sentry atende todos os ambientes

A CLI cria um projeto Sentry por aplicação. O SDK Sentry envia o nome do ambiente em cada evento.

O Sentry cria a lista de ambientes observados após receber eventos. A CLI não cria ambientes Sentry separados.

## A CLI separa credenciais administrativas de credenciais de runtime

`observability auth login` salva os tokens administrativos no arquivo local de credenciais. O arquivo usa o modo `0600`.

O provisionamento usa esses tokens para criar recursos remotos. A CLI cria um token Axiom com acesso somente para ingestão.

A CLI não grava segredos nos assets em `observability/`. `observability env export` imprime as variáveis para integração com Kamal ou outro gerenciador de segredos.

## O estado local preserva segredos que o provider não retorna

O Axiom retorna o valor do token somente na criação ou na regeneração. A CLI salva esse valor no arquivo local de credenciais.

Se esse estado local for perdido, a CLI encontra o token remoto sem acesso ao valor. Nesse caso, `--rotate-token` regenera o token e salva o novo valor.

## Ambientes configurados e ambientes observados têm significados diferentes

`observability env list` mostra os ambientes configurados por esta CLI. A lista vem do arquivo local de credenciais.

Um ambiente observado contém telemetria no destino. Ele passa a existir após o primeiro evento chegar ao Axiom ou ao Sentry.

Consulte [Configurar um projeto com ambientes remotos](setup-project-environments.md) para executar o fluxo. Consulte [Referência da CLI](cli-reference.md) para ver os comandos e os erros.
