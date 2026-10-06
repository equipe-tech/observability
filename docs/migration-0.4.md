# Migrar o SDK e a CLI para 0.4

A linha 0.4 exige `effect@4.0.1`, a primeira versão estável do Effect 4. A linha 0.3 aceita somente `effect@4.0.0-rc.111` e `effect@4.0.0-rc.112`. O Effect 4.0 move módulos e renomeia APIs, por isso as duas linhas não compartilham o mesmo runtime. Faça estas mudanças antes de atualizar os pacotes.

## Atualizar o Effect

Instale `effect@4.0.1` e todos os pacotes `@effect/*` na mesma versão. O Effect publica todos os pacotes com um único número de versão.

```sh
bun add --exact effect@4.0.1 @effect/platform-node@4.0.1
```

Os pacotes do SDK declaram o peer `effect@~4.0.1`, que aceita versões a partir de `4.0.1` e anteriores a `4.1.0`. O SDK usa APIs marcadas como `@stability unstable`, como `effect/http` e `effect/observability`. O Effect pode alterar essas APIs em versões minor. Mantenha uma única cópia de `effect` na aplicação.

## Atualizar todos os pacotes juntos

Atualize `@equipe-tech/observability` e os pacotes de integração para `0.4.x` na mesma mudança. Os pacotes de integração declaram o peer `@equipe-tech/observability@0.4.x`. Não combine pacotes 0.3 e 0.4.

| Pacote                              | Versão  |
| ----------------------------------- | ------- |
| `@equipe-tech/observability`        | `0.4.x` |
| `@equipe-tech/observability-cli`    | `0.4.x` |
| `@equipe-tech/observability-effect` | `0.4.x` |
| `@equipe-tech/observability-evlog`  | `0.4.x` |
| `@equipe-tech/observability-nestjs` | `0.4.x` |
| `@equipe-tech/observability-react`  | `0.4.x` |
| `@equipe-tech/observability-sentry` | `0.4.x` |

A CLI 0.4 depende diretamente de `effect@4.0.1`, `@effect/platform-bun@4.0.1` e `@effect/platform-node-shared@4.0.1`. Aplicações que importam `@equipe-tech/observability-cli/testing` ou `@equipe-tech/observability-cli/query` também precisam de `effect@4.0.1`.

## Trocar os caminhos de import do Effect

O Effect 4.0 remove o prefixo `effect/unstable/`. Troque os imports da aplicação:

| Caminho 0.3                     | Caminho 0.4            |
| ------------------------------- | ---------------------- |
| `effect/unstable/http`          | `effect/http`          |
| `effect/unstable/httpapi`       | `effect/http-api`      |
| `effect/unstable/observability` | `effect/observability` |
| `effect/unstable/cli`           | `effect/cli`           |
| `effect/unstable/process`       | `effect/process`       |

A composição do adapter Effect passa a usar `effect/http`:

```ts
import { HttpRouter } from "effect/http";
import { layerObservability } from "@equipe-tech/observability-effect";
```

O check de conformidade `pipeline.no-application-otlp` rejeita imports de `effect/observability` no código da aplicação. Ele continua a rejeitar o caminho antigo `effect/unstable/observability`. Imports de `effect/http` e dos seus submódulos continuam permitidos.

## Revisar APIs renomeadas no Effect 4.0

O código da aplicação pode usar APIs que o Effect alterou entre `4.0.0-rc.111` e `4.0.1`. Revise estes casos frequentes:

- Os construtores de `Config` usam PascalCase, como `Config.String` e `Config.Int`. `Config.mapOrFail` passa a ser `Config.mapEffect`.
- Os construtores de `effect/cli` usam PascalCase. `Flag.string` passa a ser `Flag.String`, `Flag.integer` passa a ser `Flag.Int` e `Prompt.password` passa a ser `Prompt.Password`.
- `onExcessProperty: "preserve"` foi removido dos parsers de `Schema`. Modele campos adicionais com `Schema.StructWithRest` ou `Schema.Record`.
- `fiber.currentSpan` passa a ser `fiber.cache.span`.
- `HttpServer.address` usa `NetAddress.SocketAddress`. O tag `TcpAddress` passa a ser `InetAddressV4` ou `InetAddressV6`.
- `partition` em `Array`, `Effect` e `Record` retorna os sucessos antes das falhas.

Consulte o changelog do pacote `effect` para a lista completa.

## Atualizar o Vitest

`@effect/vitest@4.0.1` exige Vitest 5. Atualize o Vitest antes de atualizar `@effect/vitest`.

## Gerar setups novos

`observability setup write --install` instala a versão mais recente de `effect`. Se a versão instalada for `4.1.0` ou posterior, instale `effect@4.0.1` com `bun add --exact effect@4.0.1`.
