# Migrar o SDK e a CLI para 0.3

A próxima versão minor altera contratos públicos de identidade e nomes da CLI. Faça estas mudanças antes de atualizar os pacotes.

## Aninhar a identidade em `TelemetryConfig`

Substitua os campos de identidade no nível superior pelo campo `identity`.

```ts
const identity = await Effect.runPromise(
  parseResourceIdentity({
    serviceName: "checkout-api",
    serviceVersion: "1.4.0",
    environment: "production",
  }),
);
const config = new TelemetryConfig({
  identity,
  otlpEndpoint: new URL("http://localhost:4318"),
});
```

O construtor exige um `ResourceIdentity` analisado. Use o parser Effect `parseResourceIdentity` em toda fronteira externa. Uma identidade inválida falha com `OBS_RESOURCE_IDENTITY_INVALID` antes da construção de `TelemetryConfig`.

## Corrigir nomes de serviço e ambiente

`serviceName` e `environment` aceitam segmentos com letras minúsculas e números. Um único hífen separa os segmentos. O primeiro e o último caracteres precisam ser alfanuméricos. Nomes como `checkout--api`, `-production` e `production-` são inválidos.

`serviceName` aceita no máximo 63 caracteres. `environment` aceita no máximo 32 caracteres.

## Usar um identificador de release válido

A versão 0.2.1 aceitava qualquer string não vazia em `serviceVersion`. A versão 0.3 aceita somente SemVer 2.0.0 ou um identificador imutável de release com 7 a 64 caracteres hexadecimais minúsculos.

O valor `latest` era válido em 0.2.1 e agora é rejeitado. Troque-o pela versão publicada, como `1.4.0`, ou pelo hash do commit implantado, como `9f2c1ab`. Um valor inválido produz `OBS_RESOURCE_IDENTITY_INVALID` no campo `service.version`.

A mesma regra vale para `OTEL_SERVICE_VERSION` quando a configuração vem de `telemetryConfigFromEnv`.

## Usar nomes pontuados em atributos

A versão 0.3 exige nomes minúsculos e pontuados em logs, spans, eventos de contrato, eventos de span, defeitos, resources e métricas. Cada nome precisa de pelo menos dois segmentos. O runtime descarta chaves incompatíveis. Ele não converte chaves da aplicação porque uma conversão silenciosa poderia criar colisões.

| Chave antiga       | Chave 0.3                  |
| ------------------ | -------------------------- |
| `requestId`        | `request.id`               |
| `userId`           | `user.id`                  |
| `component`        | `service.component`        |
| `region`           | `deployment.region`        |
| `fiberId`          | `effect.fiber.id`          |
| `logSpan.database` | `effect.log_span.database` |

A versão 0.3 exige nomes estáveis e pontuados para atributos de métricas. Troque chaves de segmento único, como `region`, por nomes de domínio, como `deployment.region`. Remova os identificadores reservados `unit`, `time_unit`, `service.instance.id`, `trace.id`, `span.id`, `user.id` e `session.id`. Strings de rótulo agora aceitam no máximo 64 caracteres e não aceitam formatos de identificador. A API rejeita essas violações com `MetricsError` e código `POLICY_BLOCKED`.

Cada instrumento aceita no máximo 100 valores distintos por rótulo durante a vida do runtime. Reduza a cardinalidade antes da atualização. O valor 101 produz `MetricsError` com código `LIMIT_EXCEEDED`.

## Renomear campos agora reservados

A versão 0.3 reserva campos preenchidos pelos sinks. Remova das definições de atributos da aplicação `event.source`, `event.policy_dropped_attributes`, `browser.event.id`, `browser.event.occurred_at`, `error.name` e `error.status`. Esses nomes, junto com os demais campos canônicos listados no contrato de telemetria, produzem `OBS_CONTRACT_RESERVED_ATTRIBUTE_NAME` durante a compilação do contrato.

Remova também os atributos da aplicação `audit.outcome`, `audit.reason_code`, `audit.tenant.id`, `audit.record.id`, `audit.record.hash`, `audit.occurred_at` e `audit.schema_version`. A versão 0.3 reserva esses campos para cópias operacionais de auditoria.

## Limitar timestamps ao intervalo do OTLP

Eventos de servidor e browser aceitam timestamps entre `1970-01-01T00:00:00.000Z` e `2554-07-21T23:34:33.709Z`, inclusive. O limite superior corresponde a `18446744073709` milissegundos desde o epoch. Corrija relógios de dispositivo e timestamps fornecidos pela aplicação antes da emissão. Valores fora desse intervalo podem fazer o Collector rejeitar o lote inteiro.

## Atualizar atributos sensíveis do contrato

A versão 0.3 mascara atributos classificados como `sensitive` com `****`, registra a transformação em `EmitReceipt.redactions` e grava o evento. Esse caso não retorna mais `OBS_EVENT_RESTRICTED_ATTRIBUTE`. Atributos `forbidden` continuam rejeitados antes do sink.

## Atualizar recibos de eventos

O variante `recorded` de `EmitReceipt` agora exige `redactions`. O campo contém todos os registros de máscara, truncamento e descarte aplicados ao evento. Consumidores que constroem recibos manualmente precisam fornecer `redactions: []` quando nenhuma regra alterou o evento. Código que verifica ou serializa o recibo deve aceitar o novo campo obrigatório.

## Tratar falhas de política no runtime Node

O canal de erro de `node/Runtime.layer` e `Telemetry.layerFromEnv` agora inclui `InvalidDataPolicy`. Código que fornece essas Layers deve tratar essa falha tipada junto com as falhas de identidade, ambiente e release que já existiam. Uma política de atributos de resource inválida usa o código `OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE` e não inicia o runtime.

## Renomear projetos incompatíveis com a CLI

A CLI 0.2 aceitava hífens consecutivos em `provision --name` e nos nomes de projeto dos comandos `env`. A CLI 0.3 aplica a mesma gramática de `serviceName` nesses argumentos. Renomeie `checkout--api` para `checkout-api` antes de atualizar. Um nome incompatível retorna `OBS_CLI_PROVISION_INVALID_NAME` em `provision` ou `OBS_CLI_REMOTE_INVALID_PROJECT` em comandos `env`.

## Informar a release ao exportar ambientes

`observability env export` agora exige `--release` ou `-r`.

```text
observability env export --name checkout-api --environment staging --release 1.4.0
```

A CLI valida a mesma gramática de `service.version` e exporta `OTEL_SERVICE_VERSION`. Scripts antigos sem a flag falham no parse da CLI. Atualize cada integração para fornecer a versão publicada ou o hash imutável implantado.

Ambientes com Collector remoto também precisam definir `OTEL_DEPLOYMENT_ENVIRONMENT`. Somente endpoints loopback recebem os padrões `0.0.0` e `development`.

Remova `SENTRY_RELEASE` e `OTEL_SERVICE_RELEASE`. Um valor não vazio em qualquer uma delas falha com `OBS_TELEMETRY_DUPLICATE_RELEASE_VARIABLE`. O adapter Sentry usa `OTEL_SERVICE_VERSION`.

## Migrar produção de métricas para o contrato

Declare cada métrica no campo `metrics` de `defineTelemetryContract`. Troque nomes, unidades, limites e listas de atributos passados diretamente a `metrics.counter`, `metrics.histogram` ou `metrics.observableGauge` por aliases do contrato. Obtenha o facade por `observability.metrics` e crie o produtor com `makeMetricProducer(contract, observability.metrics)`.

O produtor exige todos os atributos declarados e rejeita atributos extras. Listas `allowedValues` estreitam o tipo aceito pelo chamador. `maximumCardinality` aplica um limite de 1 a 100 antes dos limites gerais do runtime. `createMetrics` continua compatível para adapters e integrações de baixo nível, mas código de aplicação deve usar o produtor ligado ao contrato.

## Compatibilidade de release

Esta migração documenta a quebra intencional da linha 0.3. O OBS-57 adicionará a verificação automatizada de compatibilidade e o bloqueio de versionamento.

## Migrar os entrypoints de Effect e NestJS

`WideEvent` e `layerWideEvent` não pertencem mais à raiz do núcleo. Importe ambos do entrypoint Effect:

```ts
import { WideEvent, layerWideEvent } from "@equipe-tech/observability/effect";
```

O tipo público `WideEventFields` foi removido. Substitua-o por `EventAttributes`, exportado pela raiz do núcleo:

```ts
import type { EventAttributes } from "@equipe-tech/observability";
```

O caminho `@equipe-tech/observability/nestjs` foi removido. Instale `@equipe-tech/observability-nestjs@0.3.x` e importe a integração pela raiz do pacote:

```ts
import {
  createBrowserEventsController,
  TelemetryInterceptor,
  TelemetryModule,
} from "@equipe-tech/observability-nestjs";
```

O núcleo mantém `./metrics`, `./node`, `./browser`, `./browser/client` e `./testing`. `effect@4.0.0-rc.111` passa a ser peer obrigatório do núcleo e dos pacotes de integração. O consumidor deve instalar uma única cópia.

## Instalar o adapter oficial de eventos

Instale `@equipe-tech/observability-evlog@0.3.x` e registre `evlogAdapter().registration` em `createNodeObservability`. Forneça `observability.eventLayer` ao `EventProducer.emit`. O adapter depende diretamente de `evlog@2.27.1`; a aplicação não monta fila, retry ou transporte.

O ingest HTTP do browser agora exige a mesma layer. Passe `{ eventLayer: observability.eventLayer }` para `createBrowserEventsController`. Implementações próprias de `TelemetryEventSink` devem trocar `recordBrowser` por `recordBrowserBatch` e validar o lote inteiro antes de produzir qualquer efeito. Remova a composição manual de `EvlogModule` para o fluxo de eventos de contrato.

## Migrar auditorias do servidor

Declare ações em `auditActions` e use `AuditOutcome` quando uma auditoria precisa representar `denied`. `EventOutcome` não mudou. Troque razões livres por códigos fechados em `reasonCodes`.

Mantenha o ledger no banco de dados da aplicação. Use `commitAuditRecord` ou `recordAudit` e persista o `AuditCommitDocument` recebido pelo callback na mesma operação durável do ledger. Forneça `layerNodeAuditDigest` e `observability.auditLayer` no runtime Node. Todo contrato com `auditActions` deve adicionar `Contract.organizationEvents.AuditRecorded` em `events` antes do startup. Sem essa migração, o adapter evlog falha ao iniciar com `OBS_EVLOG_AUDIT_CONTRACT_INVALID`. Não publique auditorias pelo browser ou pelo pacote React. A chamada direta `log.audit()` não é suportada.

## Usar releases independentes

Os pacotes não compartilham versão. O núcleo, o adapter evlog e o pacote NestJS começam em `0.3.0`. A CLI permanece em `0.2.1`. Tags usam `<slug>@<semver>`, por exemplo `observability@0.3.0`, `observability-evlog@0.3.0`, `observability-nestjs@0.3.0` e `observability-cli@0.2.1`.
