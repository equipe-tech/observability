# @equipe-tech/observability

Biblioteca OpenTelemetry da Equipe Tech para aplicações Effect, Node.js, NestJS e browser.

## Instalação

```sh
npm install @equipe-tech/observability effect
```

## Entrypoints

- `@equipe-tech/observability`: configuração, eventos de browser e wide events.
- `@equipe-tech/observability/metrics`: métricas imperativas sem tipos Effect na API pública.
- `@equipe-tech/observability/node`: runtime OTLP para Node.js e ingestão de eventos do browser.
- `@equipe-tech/observability/nestjs`: interceptor HTTP, módulo de ciclo de vida e correlação de eventos por requisição.
- `@equipe-tech/observability/browser`: serviço Effect de telemetria do browser.
- `@equipe-tech/observability/browser/client`: cliente imperativo de browser sem tipos Effect na API pública.
- `@equipe-tech/observability/testing`: captura OTLP em memória para testes.

O adapter NestJS suporta NestJS 10 e 11 com Express. Os peers NestJS e RxJS são opcionais para consumidores que não usam esse entrypoint.

Consulte a [documentação completa](https://github.com/equipe-tech/observability#readme) para configuração, política de dados, semântica HTTP e exemplos.

## Licença

Apache-2.0
