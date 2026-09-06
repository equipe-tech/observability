# @equipe-tech/observability

Núcleo neutro de observabilidade da Equipe Tech para OpenTelemetry, contratos, políticas e ciclo de vida.

## Instalação

```sh
npm install @equipe-tech/observability effect
```

`effect@4.0.0-rc.111` é um peer obrigatório. O consumidor e os adapters compartilham a mesma cópia do runtime.

## Entrypoints

- `@equipe-tech/observability` contém configuração, contratos, identidade, política e composição neutra.
- `@equipe-tech/observability/effect` contém `WideEvent` e `layerWideEvent`.
- `@equipe-tech/observability/metrics` contém métricas imperativas sem tipos Effect na API pública.
- `@equipe-tech/observability/node` contém o runtime OTLP para Node.js e a ingestão de eventos do browser.
- `@equipe-tech/observability/browser` contém o serviço Effect de telemetria do browser.
- `@equipe-tech/observability/browser/client` contém o cliente imperativo sem tipos Effect na API pública.
- `@equipe-tech/observability/testing` contém captura OTLP em memória para testes.

A integração NestJS pertence a `@equipe-tech/observability-nestjs`. O núcleo não importa NestJS, RxJS, reflect-metadata, evlog, React ou Sentry.

Consulte a [documentação completa](https://github.com/equipe-tech/observability#readme) para configuração, política de dados, semântica HTTP e exemplos.

## Licença

Apache-2.0
