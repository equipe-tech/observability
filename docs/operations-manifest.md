# Manifesto de operações

`observability/operations.yaml` declara o estado desejado dos providers. A CLI aceita somente `version: 1`. Ela decodifica YAML, o índice de contrato e todas as queries antes de carregar credenciais ou chamar um provider.

`observability/contract.json` é um artefato gerado e versionado. Gere-o com `Contract.contractIndex` e `Contract.encodeContractIndex`. O terceiro argumento de `contractIndex` aceita metadados de aliases na versão 1, com sinais `source` e `target`. Uma origem pode apontar para vários eventos compatíveis. Origens métricas com vários destinos exigem o mesmo tipo, unidade e conjunto de atributos em todos os destinos. O gerador rejeita conjuntos incompatíveis, nomes inválidos, destinos ausentes e ciclos, e ordena a saída. O campo `contractVersion` do manifesto deve ser igual ao índice. A CLI mantém uma cópia pequena do schema do índice e da gramática de nomes para não depender do pacote de runtime.

## Comandos

```sh
observability ops plan --dir . --environment staging
observability ops apply --dir . --environment staging --plan .observability/plan-<digest>.json
observability ops verify --dir . --environment staging
```

Todos aceitam `--json`. `plan` faz somente leituras remotas e grava um plano com SHA-256. O plano contém fingerprints, precondições observadas e nomes de recursos. Ele não contém queries, tokens, DSNs ou corpos de resposta.

`apply` exige o arquivo exato. A CLI recalcula o manifesto, o contrato e o estado remoto. Mudanças destrutivas exigem `--allow-destructive`, que autoriza somente o digest fornecido. Mudança de tipo de dataset e redução de retenção são destrutivas. A CLI nunca remove drift automaticamente.

Cada mutação grava a intenção em `$OBSERVABILITY_HOME/operations/<service>.json` antes da chamada. O arquivo usa modo `0600`, escrita atômica, comparação da geração esperada e lock com lease de heartbeat. Operações ativas renovam o heartbeat. A CLI recupera somente leases expirados, sem depender da identidade ou da permissão do PID.

Falhas HTTP 4xx que provam que a criação não ocorreu encerram a intenção antes de retornar o erro. Timeout, falha de transporte, resposta 5xx, interrupção e read-back inconclusivo preservam `outcome-unknown`. Na próxima execução, a CLI reconcilia automaticamente a criação idempotente de dataset. O estado remoto desejado conclui a intenção. A ausência remota prova que uma nova tentativa é segura. A CLI faz read-back com até seis tentativas. Cada requisição HTTP tem prazo externo de dois segundos, inclusive quando o transporte ignora o cancelamento.

## Queries gerenciadas

Uma query começa com `signal(logs)`, `signal(traces)` ou `signal(metrics)`. Os estágios aceitos são `where` e `summarize`. Predicados aceitam comparações literais e `in`. Agregações aceitam `count`, `sum`, `avg`, `min`, `max` e `quantile`. Agrupamentos aceitam campos e `bin` com duração fixa.

A query deve conter exatamente um predicado estruturado de `event.name` ou `metric.name`. O predicado deve corresponder às fontes declaradas e a todos os destinos expandidos de cada alias. Filtros e agrupamentos herdam os atributos de todos os destinos. Agregações métricas precisam ser legais para todos eles. A CLI rejeita OR, comentários, joins, subqueries, regex, funções dinâmicas e texto arbitrário de provider. `compileManagedQuery` recebe `target.signals` e renderiza aliases a partir da AST.

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

Recursos sem ciclo público verificado viram ações manuais persistidas. A conclusão é uma confirmação do operador, nunca uma afirmação de verificação pelo provider. `verify` falha enquanto houver ação pendente ou expirada que ainda exista no manifesto atual. A CLI descarta ações de dashboards, monitores e outros recursos removidos na próxima mutação de estado. Retenção, projeto Sentry e client key são reconsultados em todo `plan` e `verify`. Cada nome exato de dataset precisa aparecer uma vez. Duplicatas ou nomes apenas prefixados não satisfazem o pré-requisito. Drift de um pré-requisito legível invalida a confirmação anterior. Ações manuais destrutivas usam `--allow-destructive` e `--confirm-manual` no mesmo digest exato.
