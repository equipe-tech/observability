# Contrato de telemetria

`defineTelemetryContract` compila a fonte tipada de eventos, métricas e ações de auditoria de uma aplicação. O contrato usa aliases estáveis para chamadas do produtor e mantém o nome canônico dentro de cada definição.

```ts
import { Contract, defineTelemetryContract, makeEventProducer } from "@equipe-tech/observability";

const contract =
  yield *
  defineTelemetryContract({
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

const producer = makeEventProducer(contract);
```

O produtor aceita somente aliases do contrato. O alias selecionado determina os campos por tipo de evento e os atributos permitidos. A aplicação fornece campos semânticos. O produtor preenche o timestamp e a severidade padrão.

## Nomes

Um nome de evento tem de duas a quatro partes separadas por pontos e no máximo 128 caracteres. Cada parte começa com uma letra minúscula e aceita letras minúsculas, números e sublinhados. Partes que representam ambiente, severidade, resultado ou identificador são inválidas.

`browser.error` é a exceção obrigatória para a palavra `error`. O contrato rejeita outras partes de resultado ou severidade, como `payment.failure` e `worker.errored`.

Nomes de atributos usam partes minúsculas separadas por pontos e têm no máximo 128 caracteres. Valores de atributos são strings, números finitos ou booleanos.

## Eventos canônicos

A união `TelemetryEvent` tem cinco variantes.

- `request` exige `outcome`, `durationMs` e contexto HTTP.
- `operation` exige `outcome` e `durationMs`.
- `domain` exige `outcome`.
- `defect` exige contexto de erro. O resultado é sempre `failure`.
- `audit` exige `outcome` e contexto de auditoria.

Timestamps usam RFC 3339 em UTC e terminam em `Z`. Durações são números finitos maiores ou iguais a zero. `EventSeverity` e `EventOutcome` são uniões fechadas independentes. Severidade não escolhe destino ou provedor.

## Amostragem

`always` grava todo evento elegível. `rate` aceita um número finito maior que zero e menor ou igual a um. A política `rate` se aplica somente a eventos bem-sucedidos que são elegíveis para amostragem.

O produtor sempre grava:

- auditorias;
- defeitos;
- falhas;
- canários;
- eventos com `mandatory: true`.

Canários usam `mandatory: true` na definição. Um resultado `cancelled` continua elegível para a política declarada.

## Eventos da organização

`Contract.organizationEvents` exporta oito contratos sem nomes de produto ou serviço.

| Alias              | Nome                | Tipo        | Atributos obrigatórios                       |
| ------------------ | ------------------- | ----------- | -------------------------------------------- |
| `RequestCompleted` | `request.completed` | `request`   | campos canônicos HTTP e duração              |
| `DependencyCall`   | `dependency.call`   | `operation` | `dependency.name`, `dependency.operation`    |
| `LlmCall`          | `llm.call`          | `operation` | `llm.provider`, `llm.model`, `llm.operation` |
| `SchedulerRun`     | `scheduler.run`     | `operation` | `scheduler.job`                              |
| `QueueJob`         | `queue.job`         | `operation` | `queue.name`, `queue.job`                    |
| `PaymentAttempt`   | `payment.attempt`   | `operation` | `payment.provider`, `payment.operation`      |
| `UsageRecorded`    | `usage.recorded`    | `domain`    | `usage.type`, `usage.unit`                   |
| `BrowserError`     | `browser.error`     | `defect`    | `error.origin`                               |

`BrowserError` mantém tipo, mensagem e possibilidade de repetição em `ErrorContext`. O atributo `error.origin` identifica a origem do erro no navegador sem duplicar esses campos.

## Saída WideEvent

`layerWideEvent` conecta o produtor ao `WideEvent.emit` existente. O marcador `event.kind` continua com o valor `wide`. O tipo canônico usa `event.type`.

| Campo canônico        | Atributo emitido                                                 |
| --------------------- | ---------------------------------------------------------------- |
| nome                  | `event.name`                                                     |
| tipo                  | `event.type`                                                     |
| severidade            | `event.severity`                                                 |
| resultado             | `event.outcome`                                                  |
| timestamp             | `event.timestamp`                                                |
| duração               | `event.duration_ms`                                              |
| contexto HTTP         | `http.request.method`, `http.route`, `http.response.status_code` |
| contexto de erro      | `error.type`, `error.message`, `error.retryable`                 |
| contexto de auditoria | atributos `audit.*`                                              |

## Erros

Falhas de compilação retornam `InvalidTelemetryContract` com código `OBS_CONTRACT_INVALID` e uma lista `ReadonlyArray<ContractIssue>`. A lista agrega todos os problemas encontrados. Cada item usa um código fechado `OBS_CONTRACT_*` e inclui contexto público seguro.

Falhas de emissão retornam `InvalidTelemetryEvent`. Os códigos públicos cobrem alias desconhecido, atributo não declarado, atributo obrigatório ausente, campo inválido e resultado inválido. O produtor executa essas verificações antes de chamar o sink e `WideEvent.emit`.

## Testes de consumidores

`@equipe-tech/observability/testing` exporta os contratos derivados, a lista de eventos da organização, os códigos de fixture, um sink coletor e uma camada de amostragem determinística. `Testing.run` continua sendo o caminho em memória para provar a exportação OTLP real sem mock de módulo.
