# Migrar o SDK e a CLI para 0.3

A próxima versão minor altera contratos públicos de identidade, correlação e nomes da CLI. Faça estas mudanças antes de atualizar os pacotes.

## Aninhar a identidade em `TelemetryConfig`

Substitua os campos de identidade no nível superior pelo campo `identity`.

```ts
const config = new TelemetryConfig({
  identity: {
    serviceName: "checkout-api",
    serviceVersion: "1.4.0",
    environment: "production",
  },
  otlpEndpoint: new URL("http://localhost:4318"),
});
```

O construtor aceita esse objeto simples em código tipado. Use `parseResourceIdentity` quando a identidade vier de HTTP, configuração, arquivos ou outra fronteira externa.

## Corrigir nomes de serviço e ambiente

`serviceName` e `environment` aceitam segmentos com letras minúsculas e números. Um único hífen separa os segmentos. O primeiro e o último caracteres precisam ser alfanuméricos. Nomes como `checkout--api`, `-production` e `production-` são inválidos.

`serviceName` aceita no máximo 63 caracteres. `environment` aceita no máximo 32 caracteres.

## Renomear projetos incompatíveis com a CLI

A CLI 0.2 aceitava hífens consecutivos em `provision --name` e nos nomes de projeto dos comandos `env`. A CLI 0.3 aplica a mesma gramática de `serviceName` nesses argumentos. Renomeie `checkout--api` para `checkout-api` antes de atualizar. Um nome incompatível retorna `OBS_CLI_PROVISION_INVALID_NAME` em `provision` ou `OBS_CLI_REMOTE_INVALID_PROJECT` em comandos `env`.

## Usar um identificador de release válido

`serviceVersion` aceita somente SemVer 2.0.0 ou um identificador imutável com 7 a 64 caracteres hexadecimais minúsculos. Valores como `latest`, `v1.4` e hashes com letras maiúsculas são inválidos.

Use `identity.serviceVersion` como o identificador de release. A versão 0.3 remove `releaseIdentifier` para manter uma única fonte canônica.

## Fornecer `CorrelationContext`

`TelemetryEvent.correlation` não é opcional. Produtores de evento preenchem o valor com o `CurrentCorrelation` quando o chamador omite a correlação na entrada de `emit`. Consumidores que constroem um `TelemetryEvent` diretamente precisam fornecer um `CorrelationContext` completo.

Importe `CorrelationContext` e os demais símbolos de correlação pelo entrypoint principal. A versão 0.3 remove o namespace raiz `Correlation`, e o namespace `Contract` não exporta uma segunda cópia de `CorrelationContext`.

## Compatibilidade de release

Esta migração documenta a quebra intencional da próxima versão minor. O OBS-57 adicionará a verificação automatizada de compatibilidade e o bloqueio de versionamento. O OBS-49 não implementa esse bloqueio e não altera a versão dos pacotes.
