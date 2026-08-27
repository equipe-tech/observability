# Semântica HTTP do adapter NestJS

O adapter segue OpenTelemetry HTTP Semantic Conventions v1.44.0 para spans de servidor.

## Módulo e ciclo de vida

Use `TelemetryModule.forRootAsync` para resolver a configuração pelo container do Nest e registrar o interceptor globalmente. A factory pode ser síncrona ou assíncrona e recebe os tokens declarados em `inject`.

A opção `enabled: false` não exige identidade ou endpoint e não cria runtime, exporter, timer ou requisição de rede. A configuração habilitada é analisada durante o bootstrap. Valores inválidos rejeitam o bootstrap com `InvalidTelemetryModuleOptions`.

No encerramento, o módulo fecha a admissão de spans, aguarda requisições ativas dentro do prazo configurado, faz flush do exporter compartilhado e descarta o runtime uma única vez. O prazo padrão é 5 segundos. Falhas de drain, flush ou descarte são reportadas como `TelemetryShutdownError` depois da tentativa de descarte.

O suporte usa NestJS com Express. O adapter não declara suporte ao Fastify.

## Nomes e rotas

O nome usa o método normalizado e o template completo da rota.

Duas URLs com parâmetros diferentes produzem o mesmo nome e o mesmo atributo `http.route`.

Um método desconhecido usa `_OTHER` em `http.request.method`. O nome usa `HTTP` como prefixo.

Uma rota não encontrada não produz span. O interceptor global executa depois da seleção da rota.

## Política de URL

O atributo `url.path` preserva segmentos estáticos verificados. O adapter substitui parâmetros e wildcards por `REDACTED`.

O adapter omite `url.path` quando o template usa uma gramática complexa ou não corresponde ao caminho.

O adapter nunca exporta `url.query` ou `url.full`. Esta regra é uma exceção de privacidade ao requisito condicional da convenção.

## Proxy e rede

A política padrão `direct` ignora todos os headers de encaminhamento.

Essa política usa o endereço e a porta do socket para `client.address` e `network.peer.*`.

A política `framework` usa somente `request.ip`, `request.protocol` e `request.hostname` resolvidos pelo Express.

Configure `trust proxy` no Express antes de usar `framework`. Uma configuração incorreta permite atributos de rede falsos.

## Status

| Resposta                          | Status OpenTelemetry | `error.type`        |
| --------------------------------- | -------------------- | ------------------- |
| 1xx, 2xx ou 3xx                   | Unset                | ausente             |
| 4xx                               | Unset                | ausente             |
| 5xx                               | Error                | código decimal      |
| Conexão fechada antes de `finish` | Error                | `connection_closed` |
| Cancelamento local intencional    | Unset                | ausente             |

O evento `finish` do Express fornece o código final. Assim, um filtro de exceção não deixa o valor provisório `200` no span.

Mensagens de exceção não entram no status de spans HTTP.

## Exclusões

O adapter exclui `/health` e `/_telemetry/events` por padrão.

A opção `healthRouteTemplates` adiciona templates exatos. Ela não remove as exclusões padrão.

O desligamento futuro do módulo pode fechar a admissão, aguardar requisições ativas e interromper somente os spans restantes.
