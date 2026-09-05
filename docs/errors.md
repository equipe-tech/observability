# Design de erros

Erros fazem parte da interface do produto e do modelo de observabilidade. Um erro deve permitir que um humano ou um agente entenda o que aconteceu, decida o próximo passo e correlacione uma falha pública com os traces internos, sem expor detalhes privados de implementação.

## Princípios de mensagem

### Diga o que aconteceu e por quê

Nomeie a operação que falhou e dê a razão mais específica que é segura de expor. Não use mensagens genéricas como "Algo deu errado" quando a aplicação classificou a causa.

Bom:

```text
Dataset "hibou-production-logs" não foi encontrado. Verifique o nome do dataset e tente de novo.
```

Ruim:

```text
Algo deu errado.
```

### Diga ao chamador o que fazer

Quando o chamador pode corrigir a falha, declare a ação corretiva. Quando repetir pode funcionar, diga isso e indique se a mesma operação lógica é segura de repetir. Quando o chamador não pode resolver, direcione ao suporte com um identificador de requisição.

Não sugira repetir quando a operação pode ter completado parcialmente, ou quando repetir criaria uma segunda operação lógica. O campo `retryable` deve refletir a idempotência real da operação.

## Estrutura

- Modele erros como tipos com tag no canal de erro do Effect. Cada erro carrega um código estável, a mensagem pública e os campos de contexto seguros.
- Separe a mensagem pública do diagnóstico interno. O diagnóstico completo vai para a telemetria; a resposta pública carrega o código, a mensagem e o identificador de correlação.
- Preserve a causa original em um campo `cause`. O campo `cause` é a única exceção permitida para `unknown`.
- Todo erro público inclui o identificador de correlação (`trace_id` ou id da requisição) para permitir a busca nos traces.

## Códigos do limite NestJS

- `OBS_NESTJS_ERROR_CATALOG_PREFIX_INVALID` indica que o catálogo da aplicação não declarou um prefixo estável ou tentou usar o namespace reservado `OBS_`. Defina um prefixo de aplicação não vazio em `defineErrorCatalog` e reinicie o serviço.
- `OBS_NESTJS_ERROR_CATALOG_INVALID` indica uma das quatro falhas a seguir: as declarações enumeráveis do catálogo não correspondem à lista `_codes` criada por `defineErrorCatalog`; a declaração nomeada não expõe código, status e mensagem válidos; a declaração nomeada usa mensagem templated em vez de mensagem literal; o objeto passado como catálogo não foi produzido por `defineErrorCatalog`. Reconstrua o catálogo com `defineErrorCatalog` e reinicie o serviço.
- `OBS_NESTJS_UNEXPECTED_DEFECT` é a projeção pública de um defeito sem código estável. A resposta não expõe o diagnóstico interno e inclui `request_id` e `trace_id` quando disponíveis. Use esses identificadores para localizar o evento de defeito e a captura Sentry.

## Contratos públicos

- Cada código de erro alcançável pelo chamador é parte do contrato e tem cobertura de teste.
- Não mude o significado de um código publicado. Adicione um código novo.
- Não vaze stack traces, caminhos de arquivo, queries ou configurações em respostas públicas.
