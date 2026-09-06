# Contrato de telemetria

Consulte a [política de dados](data-policy.md) para as classificações e os recibos de mascaramento aplicados pelo produtor.

`defineTelemetryContract` compila a fonte tipada de eventos, métricas e ações de auditoria de uma aplicação. O contrato usa aliases estáveis para chamadas do produtor e mantém o nome canônico dentro de cada definição.

```ts
import { Effect } from "effect";
import { Contract, defineTelemetryContract, makeEventProducer } from "@equipe-tech/observability";

const program = Effect.gen(function* () {
  const contract = yield* defineTelemetryContract({
    version: 1,
    events: {
      ...Contract.organizationEvents,
      SubscriptionRenewal: {
        name: "subscription.renewal",
        kind: "domain",
        defaultSeverity: "info",
        mandatory: false,
        sampling: { kind: "rate", rate: 0.25 },
        attributes: {
          "subscription.plan": {
            classification: "public",
            required: true,
            metricLabel: true,
          },
        },
      },
    },
    metrics: {},
    auditActions: {},
  });

  return makeEventProducer(contract);
});
```

A versão do contrato aceita qualquer inteiro positivo seguro. A versão 1 continua válida. Toda quebra classificada precisa usar uma versão maior que o baseline de compatibilidade.

O produtor aceita somente aliases do contrato. O alias selecionado determina os campos por tipo de evento e os atributos permitidos. A aplicação fornece campos semânticos. O produtor preenche o timestamp e a severidade padrão.

## Nomes

Um nome de evento tem de duas a quatro partes separadas por pontos e no máximo 128 caracteres. Cada parte começa com uma letra minúscula e aceita letras minúsculas, números e sublinhados. Partes que representam ambiente, severidade ou resultado são inválidas. A regra de identificadores rejeita partes somente numéricas, UUIDs com sublinhados e partes de pelo menos 12 caracteres que misturam letras e números. Palavras comuns formadas apenas por letras, como `decade` e `facade`, continuam válidas.

`browser.error` é a exceção obrigatória para a palavra `error`. O contrato rejeita outras partes de resultado ou severidade, como `payment.failure` e `worker.errored`.

Nomes de atributos usam pelo menos duas partes minúsculas separadas por pontos e têm no máximo 128 caracteres. Valores de atributos são strings, números finitos ou booleanos.

O contrato reserva os campos canônicos exatos `event.name`, `event.kind`, `event.type`, `event.severity`, `event.outcome`, `event.timestamp`, `event.duration_ms`, `event.source`, `event.policy_dropped_attributes`, `browser.event.id`, `browser.event.occurred_at`, `http.request.method`, `http.route`, `http.response.status_code`, `error.type`, `error.name`, `error.message`, `error.status`, `error.retryable`, `audit.action`, `audit.actor.kind`, `audit.actor.id`, `audit.resource.type`, `audit.resource.id`, `audit.outcome`, `audit.reason_code`, `audit.tenant.id`, `audit.record.id`, `audit.record.hash`, `audit.occurred_at`, `audit.schema_version`, `request.id` e `run.id`. Outros campos nesses namespaces continuam disponíveis para atributos da aplicação.

A classificação não escolhe destino ou provedor. O produtor mascara atributos `sensitive` com `****` e rejeita atributos `forbidden` antes do sink. A política compilada também remove chaves proibidas, mascara valores bloqueados e aplica os limites de cada sinal antes da exportação.

## Métricas

O registro `metrics` usa aliases e definições tipadas. Cada definição exige `name`, `description`, `unit`, `kind` e `attributes`. Os tipos aceitos são `counter`, `histogram` e `observable_gauge`. Somente histogramas aceitam `boundaries`, que devem conter de 1 a 50 números finitos em ordem crescente.

Nomes canônicos seguem exatamente `<domínio>.<medição>`, com a expressão `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` e no máximo 128 caracteres. Partes reservadas para serviço, ambiente, unidade, severidade ou resultado são inválidas. O compilador também prova que o nome satisfaz a gramática mais ampla do runtime.

Atributos formam um registro por nome. Cada atributo declara `classification` como `public` ou `internal` e `maximumCardinality` entre 1 e 100. `allowedValues`, quando presente, contém uma lista não vazia de escalares únicos que não excede `maximumCardinality`. Chaves sensíveis, proibidas ou reservadas não compilam.

O contrato compila `metricByAlias` e `metricByName`. `makeMetricProducer(contract, metrics)` cria um produtor síncrono sem tipos Effect. Os métodos `counter`, `histogram` e `observableGauge` aceitam apenas aliases do tipo correspondente. Os atributos obrigatórios e valores fechados são inferidos do contrato.

## Eventos canônicos

A união `TelemetryEvent` tem cinco variantes.

- `request` exige `outcome`, `durationMs` e contexto HTTP.
- `operation` exige `outcome` e `durationMs`.
- `domain` exige `outcome`.
- `defect` exige contexto de erro. O resultado é sempre `failure`.
- `audit` exige `outcome` e contexto de auditoria. A ação precisa existir em `auditActions`; o tipo de recurso, o resultado e o código de razão precisam corresponder à definição.

`AuditOutcome` acrescenta `denied` sem alterar `EventOutcome`. Cada ação pode declarar um catálogo fechado `reasonCodes`. Consulte [Auditoria no servidor](audit.md) para o registro durável e a cópia operacional.

Timestamps representam datas reais em RFC 3339 UTC, terminam em `Z` e não ultrapassam `2554-07-21T23:34:33.709Z`. Esse limite corresponde ao maior milissegundo que o encoder pode converter para o `fixed64` de nanossegundos do OTLP. Durações são números finitos maiores ou iguais a zero. `EventSeverity` e `EventOutcome` são uniões fechadas independentes. O compilador do contrato valida a severidade padrão. Severidade não escolhe destino ou provedor.

## Amostragem

`always` grava todo evento elegível. `rate` aceita um número finito maior que zero e menor ou igual a um. A política `rate` pode descartar eventos elegíveis com resultado `success` ou `cancelled`. O produtor sempre grava eventos com resultado `failure`.

O produtor sempre grava:

- auditorias;
- defeitos;
- falhas;
- canários;
- eventos com `mandatory: true`.

Canários usam `mandatory: true` na definição. Um resultado `cancelled` continua elegível para a política declarada.

## Eventos da organização

`Contract.organizationEvents` exporta nove contratos sem nomes de produto ou serviço. `Contract.organizationContractVersion` identifica esse conjunto reutilizável com a versão `1`. Essa identidade evolui de forma independente da versão do contrato de cada aplicação que incorpora as definições.

| Alias              | Nome                | Tipo        | Atributos obrigatórios                       |
| ------------------ | ------------------- | ----------- | -------------------------------------------- |
| `RequestCompleted` | `request.completed` | `request`   | nenhum                                       |
| `DependencyCall`   | `dependency.call`   | `operation` | `dependency.name`, `dependency.operation`    |
| `LlmCall`          | `llm.call`          | `operation` | `llm.provider`, `llm.model`, `llm.operation` |
| `SchedulerRun`     | `scheduler.run`     | `operation` | `scheduler.job`                              |
| `QueueJob`         | `queue.job`         | `operation` | `queue.name`, `queue.job`                    |
| `PaymentAttempt`   | `payment.attempt`   | `operation` | `payment.provider`, `payment.operation`      |
| `UsageRecorded`    | `usage.recorded`    | `domain`    | `usage.type`, `usage.unit`                   |
| `AuditRecorded`    | `audit.recorded`    | `audit`     | nenhum                                       |
| `BrowserError`     | `browser.error`     | `defect`    | `error.origin`                               |

`BrowserError` mantém tipo, mensagem e possibilidade de repetição em `ErrorContext`. O atributo `error.origin` identifica a origem do erro no navegador sem duplicar esses campos.

## Recibo de emissão

`EventProducer.emit` retorna `EmitReceipt`. O variante `recorded` contém `decision`, `event` e o campo obrigatório `redactions`. Cada item de `redactions` informa a superfície, a regra e a ação de política aplicada. O array fica vazio quando a política não altera o evento. O variante `sampled_out` continua contendo `decision` e `name`.

## Saída WideEvent

`layerWideEvent` conecta o produtor ao `WideEvent.emit` existente. O marcador `event.kind` continua com o valor `wide`. O tipo canônico usa `event.type`.

| Campo canônico           | Atributo emitido                                                 |
| ------------------------ | ---------------------------------------------------------------- |
| nome                     | `event.name`                                                     |
| tipo                     | `event.type`                                                     |
| severidade               | `event.severity`                                                 |
| resultado                | `event.outcome`                                                  |
| timestamp                | `event.timestamp`                                                |
| duração                  | `event.duration_ms`                                              |
| contexto HTTP            | `http.request.method`, `http.route`, `http.response.status_code` |
| contexto de erro         | `error.type`, `error.message`, `error.retryable`                 |
| contexto de auditoria    | atributos `audit.*`                                              |
| correlação de requisição | `request.id`                                                     |
| correlação de execução   | `run.id`                                                         |

## Correlação tipada

`CorrelationContext` usa `TraceLinkage` para representar dois estados. `Untraced` não contém IDs de trace. `Traced` sempre contém `traceId` e `spanId`, portanto um vínculo parcial não compila. IDs de trace usam 32 caracteres hexadecimais minúsculos e IDs de span usam 16. Valores compostos apenas por zeros são inválidos.

`requestId` e `runId` aceitam de 1 a 128 caracteres sem caracteres de controle. Quando `emit` omite `correlation`, o produtor herda o `CurrentCorrelation` ambiente. Esse comportamento mantém eventos emitidos dentro de uma requisição no mesmo contexto.

`withBackgroundCorrelation` é a fronteira explícita para trabalho em segundo plano. Ele exige um contexto e cria um novo trace raiz quando o contexto é `Untraced`. Assim, um job não herda IDs de uma requisição ambiente. Um contexto `Traced` cria um span filho do vínculo externo e mantém `traceId` e `spanId` nos campos nativos OTLP.

Use `generateRunId("job", nome)` para jobs e `generateRunId("canary", nome)` para canários. O helper normaliza o nome para minúsculas, limita o resultado a 128 caracteres e adiciona tempo e entropia. Jobs recebem o prefixo `job-`. Canários recebem `test-`.

## Erros

Falhas de compilação retornam `InvalidTelemetryContract` com código `OBS_CONTRACT_INVALID` e uma lista `ReadonlyArray<ContractIssue>`. A lista agrega todos os problemas encontrados. Cada item usa um código fechado `OBS_CONTRACT_*` e inclui contexto público seguro.

Falhas de emissão retornam `InvalidTelemetryEvent`. O produtor executa todas as verificações antes de chamar o sink e `WideEvent.emit`.

| Código                             | Significado                                     |
| ---------------------------------- | ----------------------------------------------- |
| `OBS_EVENT_UNKNOWN_NAME`           | O alias do evento não existe no contrato.       |
| `OBS_EVENT_UNDECLARED_ATTRIBUTE`   | O contrato não declara o atributo fornecido.    |
| `OBS_EVENT_MISSING_ATTRIBUTE`      | Um atributo obrigatório não foi fornecido.      |
| `OBS_EVENT_INVALID_FIELD`          | Um campo tem valor ou estrutura inválida.       |
| `OBS_EVENT_INVALID_OUTCOME`        | O resultado não é válido para o tipo de evento. |
| `OBS_EVENT_RESTRICTED_ATTRIBUTE`   | Um atributo proibido recebeu um valor.          |
| `OBS_EVENT_SENSITIVE_METRIC_LABEL` | Um atributo sensível foi declarado como rótulo. |
| `OBS_EVENT_UNKNOWN_AUDIT_ACTION`   | A ação de auditoria não existe no contrato.     |
| `OBS_EVENT_INVALID_AUDIT_RESOURCE` | O tipo de recurso difere da ação declarada.     |
| `OBS_EVENT_INVALID_AUDIT_OUTCOME`  | A ação de auditoria não permite o resultado.    |
| `OBS_EVENT_INVALID_AUDIT_REASON`   | A ação de auditoria não declara o código.       |

## Testes de consumidores

`@equipe-tech/observability/testing` exporta os tipos derivados do contrato, a lista de eventos da organização, os códigos de fixture e um sink coletor. O sink expõe `events` para eventos de servidor e `browserEvents` para eventos de browser já transformados, incluindo `admission.policyDroppedAttributes`. `withFixedSampling` fornece o serviço `Random.Random` com um valor determinístico para um programa Effect. `Testing.run` continua sendo o caminho em memória para provar a exportação OTLP real sem mock de módulo.

## Defeitos do browser

O envelope versão 2 aceita um membro opcional `error` com `type`, `message` e `retryable`. Eventos de contrato do tipo `defect` exigem esse membro. Outros eventos o rejeitam. O servidor projeta defeitos com `event.outcome` igual a `failure` e com o mesmo contexto de erro dos defeitos do servidor. Decodificadores antigos removem o membro aditivo.
