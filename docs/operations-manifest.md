# Manifesto de operações

`observability/operations.yaml` declara o estado desejado dos providers. A CLI aceita somente `version: 1`. O manifesto não aceita diretivas YAML, tags, anchors, aliases ou merge keys. A CLI decodifica o YAML, o índice de contrato e todas as queries antes de carregar credenciais ou chamar um provider.

`observability/contract.json` é um artefato gerado e versionado. Gere-o com `bun observability/contract-index.js`. O terceiro argumento de `contractIndex` aceita metadados de aliases na versão 1, com sinais `source` e `target` e uma data ISO `since`. A data inicia a janela de retenção. O artefato estrito `observability/compatibility/candidate.json` preserva a data sem ampliar o índice consumido por CLIs antigas. Uma origem pode apontar para vários eventos somente quando todos os destinos transitivos declaram o mesmo tipo, atributos e classificações. Origens métricas exigem o mesmo tipo, unidade e conjunto de atributos em todos os destinos transitivos. O gerador limita o índice a 4096 aliases, profundidade 128 e 256 destinos expandidos por origem. Ele rejeita limites excedidos com `ContractIndexAliasError`. Também rejeita conjuntos incompatíveis, nomes inválidos, destinos ausentes e ciclos, e ordena a saída. A CLI aplica os mesmos limites ao decodificar e validar o índice. O campo `contractVersion` do manifesto deve ser igual ao índice. A CLI mantém uma cópia pequena do schema do índice e da gramática de nomes para não depender do pacote de runtime.

## Comandos

```sh
observability ops plan --dir . --environment staging --axiom-edge-deployment <edge>
observability ops apply --dir . --environment staging --axiom-edge-deployment <edge> --plan .observability/plan-<digest>.json
observability ops verify --dir . --environment staging --axiom-edge-deployment <edge>
```

Todos aceitam `--json`. `plan` faz somente leituras remotas e grava um plano com SHA-256. O plano contém fingerprints, precondições observadas, nomes de recursos, datasets, edge deployment Axiom obrigatório, token de ingestão com capacidade mínima, projeto e client key Sentry, modo da fila e os caminhos e fingerprint dos assets locais do Collector. Mudança local depois do plan torna o apply stale; `ops verify` trata assets divergentes como drift. Credenciais administrativas ou de ingestão alteradas depois do plano tornam o digest stale. O plano não contém queries, tokens, DSNs ou corpos de resposta.

`apply` exige o arquivo exato. A CLI recalcula o manifesto, o contrato, as credenciais locais e o estado remoto. O modo de fila padrão é `durable`. `best-effort` exige `--accept-best-effort-data-loss` em plan e apply para registrar no digest a aceitação explícita de perda durante interrupções. O apply persiste o token de ingestão e a configuração do ambiente em armazenamento local seguro para a sincronização posterior com GitHub. Mudanças destrutivas exigem `--allow-destructive`, que autoriza somente o digest fornecido. Mudança de tipo de dataset, rotação de token e redução de retenção são destrutivas. A CLI nunca remove drift automaticamente.

Cada mutação grava a intenção em `$OBSERVABILITY_HOME/operations/<service>.json` antes da chamada. A CLI mantém `$OBSERVABILITY_HOME/operations` e `.observability` em modo `0700`. Os arquivos usam modo `0600`, escrita atômica, comparação da geração esperada e lock com lease de heartbeat. Operações ativas renovam o heartbeat. A CLI recupera somente leases expirados, sem depender da identidade ou da permissão do PID. O estado de operações pertence ao host local. Um `OBSERVABILITY_HOME` compartilhado entre máquinas não é suportado, pois o lease de heartbeat depende do relógio e do filesystem de uma única máquina.

Falhas HTTP 4xx que provam que a criação não ocorreu encerram a intenção antes de retornar o erro. Timeout, falha de transporte, resposta 5xx, interrupção e read-back inconclusivo preservam `outcome-unknown`. Na próxima execução, a CLI reconcilia automaticamente a criação idempotente de dataset. O estado remoto desejado conclui a intenção. A ausência remota prova que uma nova tentativa é segura. A CLI faz read-back com até seis tentativas. Cada requisição HTTP tem prazo externo padrão de dez segundos, inclusive quando o transporte ignora o cancelamento. `OBSERVABILITY_CLI_REQUEST_TIMEOUT_MILLISECONDS` aceita um prazo entre 100 e 120000 milissegundos.

`verify` lê providers e o estado local sem alterá-los. Ele falha com `OBS_CLI_MUTATION_UNRESOLVED` quando uma mutação `pending` ou `outcome-unknown` pertence a um ambiente selecionado. Mutações `resolved` e mutações de outros ambientes não bloqueiam a verificação.

## Queries gerenciadas

Uma query começa com `signal(logs)`, `signal(traces)` ou `signal(metrics)`. Os estágios aceitos são `where` e `summarize`. Predicados aceitam comparações literais e `in`. Agregações aceitam `count`, `sum`, `avg`, `min`, `max` e `quantile`. Agrupamentos aceitam campos e `bin` com duração fixa.

Fontes de evento exigem `event.name` em `logs` ou `traces`. Fontes métricas exigem `metric.name` em `metrics`. O predicado deve corresponder às fontes declaradas e a todos os destinos expandidos de cada alias. Filtros, agrupamentos e agregações não podem usar atributos classificados como `forbidden`. Atributos `internal`, `public` e `sensitive` continuam disponíveis quando estão presentes em todos os destinos. Agregações métricas precisam ser legais para todos eles. A CLI tokeniza `AND` sem diferenciar maiúsculas de minúsculas e aceita até 32 caracteres de espaço em branco em cada lado do separador. Ela rejeita operadores OR, comentários, joins, subqueries, regex, funções dinâmicas e texto arbitrário de provider somente quando aparecem fora de strings. `parseManagedQuery` e `compileManagedQuery` retornam `Effect` com `ManagedQueryError` no canal de erro. O compilador valida a AST e o destino recebidos, preserva a precisão decimal de quantis e escapa aspas, barras invertidas e controles em literais APL.

As queries gerenciadas aplicam estes limites:

- 16384 caracteres no texto de entrada e no texto compilado;
- 64 estágios, 64 comparações por estágio `where` e 64 campos de agrupamento por estágio `summarize`;
- 256 valores por predicado `in`, binding ou destino, e 512 valores de predicado no total;
- 1024 nós na AST e 4096 bytes UTF-8 cumulativos em literais;
- 128 caracteres por campo e 32 caracteres por token de quantil ou duração;
- 255 bytes UTF-8 no nome do dataset e 128 bytes UTF-8 por nome de sinal.

## Dashboards e monitores

Um dashboard declara `id`, `title` e `panels`. Cada painel declara `id`, `title`, `sources` e `query`. A CLI organiza os painéis em duas colunas. Qualquer valor declarado em `filters`, inclusive uma lista vazia, falha com `OBS_CLI_DASHBOARD_FILTER_UNSUPPORTED`, pois a API V2 de dashboards não possui filtros. Filtre dentro da query de cada painel.

Um monitor declara estes campos, todos obrigatórios:

| Campo                 | Tipo                        | Regra                                             |
| --------------------- | --------------------------- | ------------------------------------------------- |
| `id`                  | slug                        | Imutável. Identifica o monitor no Axiom.          |
| `title`               | texto                       | Até 200 caracteres.                               |
| `source`              | `{ kind, name }`            | Sinal do contrato.                                |
| `query`               | query gerenciada            | Mesma gramática dos painéis.                      |
| `severity`            | `critical` ou `warning`     | Registrada na descrição do monitor.               |
| `owner`               | slug                        | Time responsável.                                 |
| `window`              | duração `<n>m` ou `<n>h`    | Janela avaliada, até `1440m`.                     |
| `threshold`           | `{ operator, value, unit }` | `operator` aceita `>`, `>=`, `<` e `<=`.          |
| `thresholdRationale`  | texto                       | Justificativa do valor.                           |
| `thresholdReviewDate` | data `AAAA-MM-DD`           | Data de revisão do threshold.                     |
| `noDataBehavior`      | `ok` ou `alert`             | `alert` dispara quando a janela não tem dados.    |
| `cooldown`            | duração `<n>m` ou `<n>h`    | Intervalo mínimo entre notificações, até `1440m`. |
| `notifierRef`         | `env:<VARIAVEL>`            | Nome da variável que contém o ID do notifier.     |
| `runbookUrl`          | URL `https`                 | Incluída na descrição do monitor.                 |
| `syntheticTest`       | `{ procedure, expected }`   | Teste sintético do alerta.                        |
| `recovery`            | `{ procedure }`             | Procedimento de recuperação.                      |

O manifesto nunca contém IDs de notifier ou URLs de webhook. `plan`, `apply` e `verify` leem o ID pela variável de `notifierRef` e falham com `OBS_CLI_NOTIFIER_UNRESOLVED` quando ela falta. O ID entra somente no corpo enviado ao Axiom e em fingerprints SHA-256.

A CLI identifica cada recurso pelo marcador `observability-managed:<service>/<environment>/<id>` na última linha da descrição. Títulos não aceitam caracteres de controle, e unidades aceitam somente letras, dígitos e `%/._-`. Assim, nenhum texto do manifesto forma uma linha de marcador. O uid do dashboard é `<service>-<environment>-<id>` e tem até 128 caracteres. Um dashboard com esse uid e sem o marcador faz o plano falhar com `OBS_CLI_PROVIDER_RESOURCE_UNMANAGED`. A CLI não adota recursos não gerenciados. Dois monitores com o mesmo marcador falham com `OBS_CLI_PROVIDER_RESOURCE_AMBIGUOUS`. Recursos sem marcador permanecem intactos. A CLI nunca apaga dashboards ou monitores.

O monitor usa o tipo `Threshold`, avaliação a cada 5 minutos ou na janela menor e `notifyEveryRun: false`. Assim, o Axiom notifica na mudança de estado e na recuperação. O `cooldown` fica registrado na descrição, pois a API V2 não possui um campo equivalente. `disabled` e `disabledUntil` ficam fora da comparação, para que um silêncio operacional não vire drift.

O plano compara uma projeção normalizada do recurso desejado com a do recurso observado. Nome, descrição, dono, gráficos, queries, layout, janela, operador, threshold, notifiers e parâmetros de disparo entram na projeção. Campos de apresentação adicionados pelo Axiom ficam fora dela. As `queryOptions` de cada gráfico entram na projeção, exceto valores padrão vazios, como `""`, `"{}"`, `"[]"` e `"false"`. Uma edição no console aparece como `update` no plano e como `OBS_CLI_DRIFT_DETECTED` em `verify`. Antes de cada atualização, a CLI relê o recurso e compara sua revisão com a do plano. A revisão do dashboard combina a projeção e a versão do Axiom. A revisão do monitor combina a projeção, o ID e o `updatedAt`. Uma divergência retorna `OBS_CLI_AXIOM_RESOURCE_CONFLICT` sem escrever. Assim, uma edição concorrente em campos fora da projeção também bloqueia o apply. A atualização de dashboard envia a versão observada com `overwrite: false`. A API de monitores não oferece atualização condicional, então resta uma janela curta entre a releitura e o `PUT`. Se o Axiom omitir `updatedAt`, a revisão do monitor cobre somente a projeção e o ID. O `PUT` de monitor substitui o documento e preserva `disabled` e `disabledUntil` observados, para não desfazer um silêncio operacional.

A criação de monitor não é idempotente, e a leitura da lista pode atrasar. Uma criação que terminou como `pending` ou `outcome-unknown` nunca se repete sozinha. A intenção de criação continua aberta até que o monitor apareça ou uma nova tentativa autorizada a substitua, mesmo quando outra ação do mesmo apply falha antes. Se o monitor aparece, o plano o trata como existente e conclui a intenção no apply. Se ele continua ausente, o plano marca a criação como `destructive`. Confira o console do Axiom e use `--allow-destructive` somente depois de confirmar a ausência.

### Compilação para o Axiom

Queries de eventos leem `signal(logs)` no dataset `<service>-<environment>-logs` em APL. Atributos do contrato usam o layout OpenTelemetry do Axiom, como `['attributes.event.name']`. `service.name`, `service.namespace` e `service.version` ficam na raiz. `deployment.environment.name` usa `['resource.deployment.environment.name']`. `bin(timestamp, <duração>)` vira `bin(_time, <duração>)`.

Queries métricas usam MPL no dataset `<service>-<environment>-metrics`. Elas aceitam estágios `where` seguidos de um único `summarize` e leem exatamente uma métrica. `in` vira uma disjunção entre parênteses. `bin` de tempo é omitido, pois o MPL alinha pelo intervalo da consulta. Cada tipo aceita uma agregação:

| Tipo               | Agregação                               | MPL                                                      |
| ------------------ | --------------------------------------- | -------------------------------------------------------- |
| `counter`          | `sum(value)`                            | `map increase`, `align using sum`, `group using sum`     |
| `histogram`        | `quantile(value, q)`                    | `bucket using interpolate_cumulative_histogram(rate, q)` |
| `observable_gauge` | `sum`, `avg`, `min` ou `max` de `value` | `align using <fn>`, `group using <fn>`                   |

Outras combinações, `signal(traces)`, aliases métricos com mais de um destino e `bin` de campos que não representam tempo falham com `OBS_CLI_QUERY_INVALID`.

## Evidência de capacidades

| Provider | Capacidade          | Operação HTTP                                                                                        | URL oficial                                                      | Consultado em | Status                                          |
| -------- | ------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| Axiom    | Listar datasets     | `GET /v2/datasets`                                                                                   | https://axiom.co/docs/reference/api                              | 2026-08-31    | verificado pelo cliente e testes HTTP locais    |
| Axiom    | Criar dataset       | `POST /v2/datasets`                                                                                  | https://axiom.co/docs/reference/api                              | 2026-08-31    | verificado pelo cliente e testes HTTP locais    |
| Axiom    | Dashboards          | `GET` e `PUT /v2/dashboards/uid/{uid}`, `POST /v2/dashboards`                                        | https://axiom.co/docs/restapi/endpoints/createDashboard          | 2026-09-24    | verificado pelo cliente e testes HTTP locais    |
| Axiom    | Monitores           | `GET` e `POST /v2/monitors`, `PUT /v2/monitors/{id}`                                                 | https://axiom.co/docs/restapi/endpoints/createMonitor            | 2026-09-24    | verificado pelo cliente e testes HTTP locais    |
| Axiom    | Retenção            | nenhuma atualização pública verificada                                                               | https://axiom.co/docs/reference/api                              | 2026-08-31    | ação manual, redução destrutiva                 |
| Axiom    | Correlation         | nenhuma operação pública estável verificada                                                          | https://axiom.co/docs/reference/api                              | 2026-08-31    | ação manual                                     |
| Sentry   | Ler e criar projeto | `GET /api/0/projects/{organization}/{project}/`, `POST /api/0/teams/{organization}/{team}/projects/` | https://docs.sentry.io/api/projects/                             | 2026-08-31    | leitura ops e provisionamento RemoteEnvironment |
| Sentry   | Ler client keys     | `GET /api/0/projects/{organization}/{project}/keys/`                                                 | https://docs.sentry.io/api/projects/list-a-projects-client-keys/ | 2026-08-31    | suportado pelo cliente legado, ciclo ops manual |
| Sentry   | Auth token          | autenticação Bearer da CLI                                                                           | https://docs.sentry.io/api/auth/                                 | 2026-08-31    | credencial da CLI, não recurso de projeto       |

O projeto Sentry canônico usa o slug do serviço, compartilhado entre os ambientes, tanto no provisionamento legado quanto na leitura do fluxo `ops`. O nome antigo `<service>-<environment>` do preflight `ops` não é mais usado. Isso evita que o planejamento consulte um projeto diferente daquele criado por `RemoteEnvironment`.

Um serviço com projetos Sentry próprios declara seus slugs em `sentry.projects`:

```yaml
sentry:
  enabled: true
  projects: [checkout-api, checkout-web]
```

A lista aceita de 1 a 20 slugs únicos com letras minúsculas, dígitos, `_` e `-`. Sem `projects`, a CLI usa `[<service>]` e mantém a criação planejada do projeto canônico. Com `projects`, a CLI apenas lê cada projeto e sua client key. O provisionamento do ambiente no apply usa somente Axiom e não cria nem troca o projeto Sentry do ambiente. A DSN exportada continua a do projeto registrado pelo provisionamento do ambiente. Esse projeto precisa constar em `sentry.projects`, ou o plano falha com `OBS_CLI_DRIFT_DETECTED`. Um projeto declarado ausente ou sem client key falha com `OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE`, sem criação. Crie esse projeto no Sentry com a plataforma correta.

As requisições aos providers não seguem redirecionamentos. Um status 3xx falha com `OBS_CLI_REMOTE_REDIRECTED` e informa somente o caminho de destino. Em uma mutação, o redirect torna o resultado desconhecido, e a CLI reconcilia a intenção antes de uma nova tentativa. O Sentry redireciona um slug renomeado para o slug atual. Nesse caso, a mensagem nomeia o projeto e pede a correção de `sentry.projects`.

O token Sentry é uma credencial de organização usada pela CLI. O recurso de projeto consumido por aplicações é a client key que contém a DSN. A CLI não inventa um token de projeto.

## Ações manuais

Retenção e Correlation não têm ciclo público verificado e viram ações manuais persistidas. A conclusão é uma confirmação do operador, nunca uma afirmação de verificação pelo provider. `verify` falha enquanto houver ação pendente ou expirada que ainda exista no manifesto atual. A CLI preserva ações e confirmações de ambientes fora do escopo selecionado. Ela descarta ações de recursos que deixam o manifesto completo, inclusive ações antigas de dashboards e monitores, na próxima mutação de estado. Retenção é reconsultada em todo `plan` e `verify`. Projeto Sentry e client key também são reconsultados. Sem `sentry.projects`, a ausência vira uma criação planejada com intenção persistida e read-back, não uma confirmação manual. Com `sentry.projects`, a ausência falha o plano. Cada nome exato de dataset precisa aparecer uma vez. Duplicatas ou nomes apenas prefixados não satisfazem o pré-requisito. Drift de um pré-requisito legível invalida a confirmação anterior. Ações manuais destrutivas usam `--allow-destructive` e `--confirm-manual` no mesmo digest exato.
