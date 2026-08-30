# Ambientes isolam dados sem acoplar a aplicação

O pacote trata o ambiente como um atributo OpenTelemetry. `OTEL_DEPLOYMENT_ENVIRONMENT` identifica `development`, `staging`, `production`, ou outro ambiente.

A aplicação envia os três sinais para um Collector. Ela não contém credenciais do Axiom e não conhece os nomes dos datasets.

## O atributo canônico preserva consultas durante a transição

O atributo canônico de resource para logs, traces e métricas é `deployment.environment.name`. A identidade inclui `service.namespace=equipe-tech`, `service.name`, `service.version` e, para logs e traces, o `service.instance.id` opcional. Métricas não recebem o identificador de instância.

Nomes de serviço usam segmentos de letras minúsculas e números, separados por um único hífen, com até 63 caracteres. Nomes de ambiente seguem a mesma gramática, com até 32 caracteres. A versão aceita SemVer 2.0.0 ou um identificador imutável hexadecimal minúsculo de 7 a 64 caracteres.

`OTEL_SERVICE_INSTANCE_ID` define `service.instance.id` para logs e traces. Um valor ausente, `undefined` ou vazio omite o atributo. Um valor não vazio aceita no máximo 128 caracteres. Métricas sempre omitem o identificador de instância.

O Collector também exporta `deployment.environment` como alias de transição.

- Se somente o atributo canônico existe, o Collector copia seu valor para o alias.
- Se somente o alias existe, o Collector copia seu valor para o atributo canônico.
- Se ambos existem com valores diferentes, o atributo canônico substitui o alias.
- Se nenhum existe, o Collector não altera o resource.

A regra usa somente atributos de resource. Atributos de spans, eventos, logs ou pontos de métricas não são entradas para a migração.

Use o campo canônico nas novas consultas Axiom:

```apl
['project-production-traces'] | where ['resource.custom']['deployment.environment.name'] == 'production'
```

As consultas existentes com o alias continuam válidas durante a transição:

```apl
['project-production-traces'] | where ['resource.custom']['deployment.environment'] == 'production'
```

A remoção do alias requer duas condições:

- Todos os produtores suportados enviam o atributo canônico.
- Nenhuma consulta, painel ou alerta usa o alias durante um período completo de retenção dos datasets.

## A compatibilidade no SDK tem prazo

`EnvironmentAliasPolicy` controla a emissão do alias pelo SDK. O padrão `omitted` emite somente `deployment.environment.name`. Use `emitted` apenas enquanto um destino antigo ainda depende de `deployment.environment`. A configuração explícita de perfil e a entrada por ambiente aceitam essa política sem combinar as duas fontes.

Os exporters do pacote ignoram `OTEL_RESOURCE_ATTRIBUTES`. Assim, valores ambientes não podem inserir ou substituir `service.namespace`, `service.name`, `service.version`, `deployment.environment.name`, `deployment.environment` ou `service.instance.id`. A identidade canônica, o alias e a instância vêm somente das projeções de `ResourceIdentity`. Atributos ambientes não reservados também são suprimidos.

A CLI mantém sua gramática de nomes local para não depender do núcleo Effect. O teste `IdentityPolicyDrift.bun.test.ts` compara a expressão regular, os limites e os fixtures de fronteira com a política do núcleo. Qualquer alteração em uma das cópias exige atualizar e revisar as duas.

O SDK remove essa opção na primeira versão minor depois que as duas condições acima permanecerem verdadeiras por um período completo de retenção, e no máximo na linha `0.4.0`. A revisão da remoção ocorre antes da publicação de cada versão minor até esse limite.

## O ambiente local não usa contas externas

O ambiente local usa `http://localhost:4318` como endpoint padrão. Endpoints em `localhost`, `127.0.0.0/8` e `::1` permitem os padrões `OTEL_SERVICE_VERSION=0.0.0` e `OTEL_DEPLOYMENT_ENVIRONMENT=development`. Essa permissão depende somente da classificação do endpoint. Um sidecar de produção acessado por loopback deve definir as duas variáveis explicitamente. Endpoints não loopback exigem as duas variáveis.

`OTEL_SERVICE_VERSION` é a única identidade de release. `SENTRY_RELEASE` e `OTEL_SERVICE_RELEASE` não podem definir outra identidade.

O Collector local envia os sinais para o `otel-desktop-viewer`.

Esse fluxo mantém o Collector entre a aplicação e o destino. O mesmo contrato OTLP existe no ambiente local e nos ambientes remotos.

## Cada ambiente remoto tem recursos isolados no Axiom

A CLI cria três datasets para cada ambiente:

- `<project>-<environment>-traces`
- `<project>-<environment>-logs`
- `<project>-<environment>-metrics`

Traces e logs usam `axiom:events:v1`. Métricas usam `otel:metrics:v1`. A CLI verifica kind, edge deployment explícito e retenção explícita no preflight. Retenção divergente é um conflito destrutivo e nunca produz PUT automático. A CLI nunca exclui um dataset incompatível. Uma métrica antiga com kind Events exige preservação e migração manual.

A CLI também cria um token de ingestão para cada ambiente. O token concede ingest-create somente aos três datasets exatos daquele ambiente.

Como Axiom não publica uma API estável de Correlation, a CLI persiste uma ação manual. A exportação permanece bloqueada até o operador criar o grupo no Console e repetir o provisionamento com `--correlation-confirmed`.

Esse isolamento permite retenções e permissões diferentes. Uma credencial de `staging` não concede acesso aos dados de `production`.

## Um projeto Sentry atende todos os ambientes

A CLI cria um projeto Sentry por aplicação. O SDK Sentry envia o nome do ambiente em cada evento.

O Sentry cria a lista de ambientes observados após receber eventos. A CLI não cria ambientes Sentry separados.

## Cada ambiente registra somente os providers configurados

Use `--provider axiom` para configurar somente Axiom. Use `--provider sentry` para configurar somente Sentry.

Repita a flag para configurar ambos. Sem a flag, um ambiente novo configura os dois providers.

Um ambiente existente repete sua seleção salva quando a flag não existe. Uma seleção explícita adiciona providers e não remove estado anterior.

Um ambiente Sentry não exporta variáveis Axiom. Ele também não exporta `OTEL_EXPORTER_OTLP_ENDPOINT`.

Os assets gerados ainda configuram um Collector Axiom. Uma execução somente Sentry não configura as variáveis desses assets.

## A CLI separa credenciais administrativas de credenciais de runtime

`observability auth login` salva os tokens administrativos no arquivo local de credenciais. O arquivo usa o modo `0600`.

O provisionamento exige credenciais somente para os providers efetivos. A CLI cria um token Axiom com acesso somente para ingestão.

A CLI não grava segredos nos assets em `observability/`. `observability env export` imprime as variáveis para integração com um gerenciador de segredos.

## O estado local preserva segredos que o provider não retorna

O Axiom retorna o valor do token somente na criação ou na regeneração. A CLI salva cada ambiente logo após receber esse valor.

Uma queda entre a resposta Axiom e a gravação local cria uma janela inevitável. Uma gravação atômica não remove essa janela.

Antes de criar ou regenerar o token, a CLI salva uma marca de mutação pendente. Se o processo cair, uma repetição comum e `observability env export` recusam o segredo local possivelmente inválido. Execute a rotação explícita do token Axiom.

Se a resposta de mutação for ilegível, retornar HTTP 5xx, usar um status 2xx inesperado ou falhar no transporte, a CLI informa `OBS_CLI_REMOTE_OUTCOME_UNKNOWN`. Não repita o comando sem rotação. Rode novamente com `--provider axiom --rotate-token`.

A CLI preserva ambientes salvos antes de uma falha posterior. `OBS_CLI_REMOTE_PARTIAL_FAILURE` lista esses ambientes.

## Ambientes configurados e ambientes observados têm significados diferentes

`observability env list` mostra os ambientes configurados por esta CLI. A lista vem do arquivo local de credenciais.

Um ambiente observado contém telemetria no destino. Ele passa a existir após o primeiro evento chegar ao Axiom ou ao Sentry.

Consulte [Configurar um projeto com ambientes remotos](setup-project-environments.md) para executar o fluxo. Consulte [Referência da CLI](cli-reference.md) para ver os comandos e os erros.
