# Semântica HTTP do adapter Effect

O pacote `@equipe-tech/observability-effect` integra a plataforma a aplicações escritas com Effect e `effect/unstable/http`. O adapter segue OpenTelemetry HTTP Semantic Conventions v1.44.0 para spans de servidor e mantém a semântica pública do [adapter NestJS](nestjs-http-semantics.md), com as diferenças declaradas neste documento.

## Composição

```ts
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import { createServer } from "node:http";
import {
  defineErrorCatalog,
  effectEventsAdapter,
  errorBoundary,
  httpTelemetry,
  layerBrowserEventsRoute,
  layerObservability,
} from "@equipe-tech/observability-effect";

const catalog = await Effect.runPromise(
  defineErrorCatalog({
    prefix: "APP",
    entries: { ITEM_NOT_FOUND: { status: 404, message: "The item does not exist." } },
  }),
);

const boundary = errorBoundary({
  catalog,
  recordDefect: (input) =>
    producer.emit("ApplicationDefect", {
      error: input.error,
      correlation: input.correlation,
      attributes: {},
    }),
});

const Routes = Layer.mergeAll(ApiRoutes, layerBrowserEventsRoute()).pipe(
  Layer.provide(boundary.combine(httpTelemetry({ proxyPolicy: "direct" })).layer),
);

const Observability = layerObservability({
  enabled: process.env.OBSERVABILITY_TELEMETRY_ROLLOUT === "enabled",
  profile: "effect-api",
  env: process.env,
  contract: telemetryContract,
  policy: observabilityPolicy,
  adapters: [effectEventsAdapter().registration],
});

export const Server = HttpRouter.serve(Routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.provideMerge(Observability),
);
```

`layerObservability` lê o ambiente com `nodeObservabilityConfigFromEnv`. `layerObservabilityFromConfig` recebe uma configuração já analisada. As duas Layers constroem o runtime do perfil, iniciam os adapters e expõem no runtime da aplicação o tracer, o logger OTLP, a política de dados, `TelemetryEventSink`, `AuditPublisher` e `NodeObservabilityService`. A Layer também desabilita o tracer HTTP embutido do Effect, porque ele exporta `url.full`, `url.query` e cabeçalhos.

Forneça a Layer de observabilidade ao servidor, não somente às rotas. As fibras de requisição herdam o contexto do servidor.

Com `enabled: false`, a Layer não cria runtime, exporter ou requisição de rede. `TelemetryEventSink` e `AuditPublisher` viram no-ops e `NodeObservabilityService.enabled` é `false`.

## Ciclo de vida

O escopo da Layer é o ciclo de vida. O servidor HTTP é finalizado antes da observabilidade porque depende dela: `NodeHttpServer` para de aceitar conexões, o escopo interrompe as fibras de requisição ativas e só então o runtime executa `close` com os prazos e o relatório do perfil. `NodeObservabilityService` expõe `flush` e `close` para uso explícito; `close` depois do encerramento do escopo devolve o mesmo relatório.

Uma configuração inválida falha a construção da Layer com `InvalidObservabilityConfig`, `DuplicateReleaseVariable` ou `ObservabilityLifecycleError`, sem conversão.

## Middleware de telemetria

`httpTelemetry(options)` devolve um `HttpRouter.Middleware`. Forneça `.layer` às Layers de rota, inclusive `HttpApiBuilder.layer`. O middleware executa dentro da rota selecionada, portanto conhece o template da rota antes de criar o span.

O span de servidor recebe `http.request.method`, `http.route`, `url.path` redigido, `url.scheme`, `client.address`, `network.peer.address`, `network.peer.port` quando o transporte expõe o socket, e `server.address` na política `framework`. O middleware fornece `Tracer.ParentSpan` e `CurrentCorrelation` com `traceId`, `spanId` e um `requestId` novo por requisição. Eventos emitidos no handler com `CurrentCorrelation` ou com `WideEvent.emit` ficam correlacionados ao span.

O span termina quando o handler produz a resposta ou falha. Falhas de escrita da resposta depois desse ponto pertencem ao servidor e não alteram o span.

## Nomes, rotas e URL

O nome usa o método normalizado e o template completo da rota, por exemplo `GET /items/:id`. Um método desconhecido usa `_OTHER` em `http.request.method` e `HTTP` como prefixo do nome. O template vem de `HttpRouter.RouteContext` e inclui o prefixo de roteadores prefixados.

`url.path` preserva segmentos estáticos verificados e substitui parâmetros `:nome` e o wildcard final `*` por `REDACTED`. O adapter omite `url.path` quando o template usa gramática complexa ou não corresponde ao caminho. O adapter nunca exporta `url.query`, `url.full` ou cabeçalhos.

## Proxy e rede

A política padrão `direct` ignora cabeçalhos de encaminhamento e usa `remoteAddress` da requisição para `client.address` e `network.peer.address`. `url.scheme` vem do socket ou da URL de origem quando o transporte os expõe; caso contrário, `http`.

A política `framework` usa `x-forwarded-proto` para `url.scheme`, o primeiro endereço IP válido de `x-forwarded-for` para `client.address` e `x-forwarded-host` ou `host` sem porta para `server.address`. `network.peer.*` continua vindo do socket. Use `framework` somente atrás de um proxy que sobrescreve esses cabeçalhos.

## Status

| Resultado do handler                      | Status OpenTelemetry | `error.type`        |
| ----------------------------------------- | -------------------- | ------------------- |
| Resposta 1xx, 2xx ou 3xx                  | Unset                | ausente             |
| Resposta 4xx                              | Unset                | ausente             |
| Resposta 5xx ou falha convertida em 5xx   | Error                | código decimal      |
| Interrupção por `ClientAbort`             | Error                | `connection_closed` |
| Interrupção local, inclusive encerramento | Unset                | ausente             |

Falhas do handler recebem o status que o servidor Effect atribuiria pela mesma regra de `HttpServerError.causeResponse`. Mensagens de exceção não entram no status de spans HTTP.

## Exclusões

O adapter exclui `/health` e `/_telemetry/events` por padrão. `healthRouteTemplates` adiciona templates exatos e não remove as exclusões padrão. Valores fora da gramática de rota falham a Layer com `OBS_EFFECT_ROUTE_POLICY_INVALID`.

## Limite de erros

`errorBoundary(options)` devolve um `HttpRouter.Middleware`. Combine com o middleware de telemetria por `boundary.combine(httpTelemetry())`, para que a telemetria fique por fora e o limite responda com a correlação da requisição.

O catálogo vem de `defineErrorCatalog({ prefix, entries })`. Cada entrada declara `status` entre 400 e 599 e uma mensagem literal pública. O código de cada entrada é `${prefix}.${nome}`; `catalog.code("NOME")` devolve o código para uso em erros tipados. Prefixos iniciados por `OBS_` são reservados e falham com `OBS_EFFECT_ERROR_CATALOG_PREFIX_INVALID`; declarações inválidas falham com `OBS_EFFECT_ERROR_CATALOG_INVALID`.

O limite usa quatro regras de classificação fechadas sobre a primeira falha ou defeito da causa.

| Resultado          | Origem                                                                                    | Resposta                                                                 | Evento e captura                                                |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `ExpectedError`    | Valor com `code` presente no catálogo                                                     | Status e mensagem do catálogo, código estável, `request_id` e `trace_id` | Nunca emite evento de defeito nem captura no Sentry             |
| `UnexpectedDefect` | Valor `Respondable` com resposta 5xx e `cause` que não é `Respondable`                    | Resposta 500 segura com correlação                                       | Emite um evento `defect` e captura no Sentry quando configurado |
| `HttpOutcome`      | Demais `HttpServerRespondable`, `HttpServerResponse`, `SchemaError`, `NoSuchElementError` | Preserva a resposta que o Effect produziria                              | Nunca emite evento de defeito nem captura no Sentry             |
| `UnexpectedDefect` | Demais falhas e defeitos                                                                  | Resposta 500 segura com correlação                                       | Emite um evento `defect` e captura no Sentry quando configurado |

Interrupções passam pelo limite sem alteração. Erros declarados em `HttpApi` já viram respostas dentro do handler e chegam ao limite como respostas.

`recordDefect` e `captureDefect` recebem a mesma correlação e executam em uma fibra separada no escopo da Layer, depois de o limite devolver a resposta. Falhas desses destinos são isoladas. As dependências dessas funções são resolvidas quando a Layer é construída. A marca de deduplicação pertence à requisição: a mesma instância de erro na mesma requisição produz um evento e uma tentativa de captura.

Quando o perfil desabilita Sentry, omita `captureDefect`. O evento de defeito continua obrigatório.

## Rota de eventos do browser

`layerBrowserEventsRoute({ path })` registra `POST /_telemetry/events` no `HttpRouter` atual. A rota exige `TelemetryEventSink`, fornecido por `layerObservability`. O handler responde `202` com o recibo de ingestão e `400 { code, message, correlationId }` para lotes inválidos. A rota fica excluída do middleware de telemetria; `correlationId` usa o `traceId` de um span ativo ou um identificador aleatório seguro para suporte. O limite de corpo pertence ao transporte HTTP por `HttpIncomingMessage.MaxBodySize`.
