# Manifesto de operações

`observability/operations.yaml` declara o estado desejado dos providers. A CLI aceita somente `version: 1`. O manifesto não aceita diretivas YAML, tags, anchors, aliases ou merge keys. A CLI decodifica o YAML, o índice de contrato e todas as queries antes de carregar credenciais ou chamar um provider.

`observability/contract.json` é um artefato gerado e versionado. Gere-o com `Contract.contractIndex` e `Contract.encodeContractIndex`. O terceiro argumento de `contractIndex` aceita metadados de aliases na versão 1, com sinais `source` e `target`. Uma origem pode apontar para vários eventos somente quando todos os destinos transitivos declaram os mesmos atributos e classificações. Origens métricas exigem o mesmo tipo, unidade e conjunto de atributos em todos os destinos transitivos. O gerador limita o índice a 4096 aliases, profundidade 128 e 256 destinos expandidos por origem. Ele rejeita limites excedidos com `ContractIndexAliasError`. Também rejeita conjuntos incompatíveis, nomes inválidos, destinos ausentes e ciclos, e ordena a saída. A CLI aplica os mesmos limites ao decodificar e validar o índice. O campo `contractVersion` do manifesto deve ser igual ao índice. A CLI mantém uma cópia pequena do schema do índice e da gramática de nomes para não depender do pacote de runtime.

## Comandos

```sh
observability ops plan --dir . --environment staging
observability ops apply --dir . --environment staging --plan .observability/plan-<digest>.json
observability ops verify --dir . --environment staging
```

Todos aceitam `--json`. `plan` faz somente leituras remotas e grava um plano com SHA-256. O plano contém fingerprints, precondições observadas e nomes de recursos. Ele não contém queries, tokens, DSNs ou corpos de resposta.

`apply` exige o arquivo exato. A CLI recalcula o manifesto, o contrato e o estado remoto. Mudanças destrutivas exigem `--allow-destructive`, que autoriza somente o digest fornecido. Mudança de tipo de dataset e redução de retenção são destrutivas. A CLI nunca remove drift automaticamente.

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

## Evidência de capacidades

| Provider | Capacidade          | Operação HTTP                                                                                        | URL oficial                                                      | Consultado em | Status                                          |
| -------- | ------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| Axiom    | Listar datasets     | `GET /v2/datasets`                                                                                   | https://axiom.co/docs/reference/api                              | 2026-08-31    | verificado pelo cliente e testes HTTP locais    |
| Axiom    | Criar dataset       | `POST /v2/datasets`                                                                                  | https://axiom.co/docs/reference/api                              | 2026-08-31    | verificado pelo cliente e testes HTTP locais    |
| Axiom    | Dashboards          | nenhuma operação pública verificada                                                                  | https://axiom.co/docs/reference/api                              | 2026-08-31    | ação manual                                     |
| Axiom    | Monitores           | nenhuma operação pública verificada                                                                  | https://axiom.co/docs/reference/api                              | 2026-08-31    | ação manual                                     |
| Axiom    | Retenção            | nenhuma atualização pública verificada                                                               | https://axiom.co/docs/reference/api                              | 2026-08-31    | ação manual, redução destrutiva                 |
| Axiom    | Correlation         | nenhuma operação pública estável verificada                                                          | https://axiom.co/docs/reference/api                              | 2026-08-31    | ação manual                                     |
| Sentry   | Ler e criar projeto | `GET /api/0/projects/{organization}/{project}/`, `POST /api/0/teams/{organization}/{team}/projects/` | https://docs.sentry.io/api/projects/                             | 2026-08-31    | suportado pelo cliente legado, ciclo ops manual |
| Sentry   | Ler client keys     | `GET /api/0/projects/{organization}/{project}/keys/`                                                 | https://docs.sentry.io/api/projects/list-a-projects-client-keys/ | 2026-08-31    | suportado pelo cliente legado, ciclo ops manual |
| Sentry   | Auth token          | autenticação Bearer da CLI                                                                           | https://docs.sentry.io/api/auth/                                 | 2026-08-31    | credencial da CLI, não recurso de projeto       |

O token Sentry é uma credencial de organização usada pela CLI. O recurso de projeto consumido por aplicações é a client key que contém a DSN. A CLI não inventa um token de projeto.

## Ações manuais

Recursos sem ciclo público verificado viram ações manuais persistidas. A conclusão é uma confirmação do operador, nunca uma afirmação de verificação pelo provider. `verify` falha enquanto houver ação pendente ou expirada que ainda exista no manifesto atual. A CLI preserva ações e confirmações de ambientes fora do escopo selecionado. Ela descarta ações de dashboards, monitores e outros recursos somente quando a definição deixa o manifesto completo, na próxima mutação de estado. Retenção, projeto Sentry e client key são reconsultados em todo `plan` e `verify`. Cada nome exato de dataset precisa aparecer uma vez. Duplicatas ou nomes apenas prefixados não satisfazem o pré-requisito. Drift de um pré-requisito legível invalida a confirmação anterior. Ações manuais destrutivas usam `--allow-destructive` e `--confirm-manual` no mesmo digest exato.
