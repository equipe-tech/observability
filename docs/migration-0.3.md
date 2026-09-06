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

## Compatibilidade de release

Esta migração documenta a quebra intencional da próxima versão minor. O OBS-57 adicionará a verificação automatizada de compatibilidade e o bloqueio de versionamento. O OBS-49 não implementa esse bloqueio e não altera a versão dos pacotes.
