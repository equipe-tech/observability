# Semântica HTTP do adapter NestJS

O adapter segue OpenTelemetry HTTP Semantic Conventions v1.44.0 para spans de servidor.

## Módulo e ciclo de vida

Use `TelemetryModule.forRootAsync` para resolver a configuração pelo container do Nest e registrar o interceptor globalmente. A factory pode ser síncrona ou assíncrona e recebe os tokens declarados em `inject`.

A opção `enabled: false` não exige identidade ou endpoint e não cria runtime, exporter, timer ou requisição de rede. A configuração habilitada é analisada durante o bootstrap. Valores inválidos e imports duplicados com configurações diferentes rejeitam o bootstrap com `InvalidTelemetryModuleOptions` e código `OBS_TELEMETRY_INVALID_MODULE_OPTIONS`. Dois imports habilitados devem omitir `requestWideEventTraceCorrelation` ou passar a mesma instância do adapter. Instâncias diferentes são um conflito determinístico detectado depois das factories e antes da aquisição do runtime, inclusive quando uma factory termina depois da outra.

Uma falha depois da configuração válida, durante a construção ou aquisição do runtime, rejeita o bootstrap com `TelemetryStartupError` e código `OBS_TELEMETRY_STARTUP_FAILED`. O módulo descarta recursos parcialmente adquiridos antes de propagar essa falha. Uma rejeição da factory do chamador é propagada sem conversão.

No encerramento, o módulo fecha a admissão de spans, aguarda ou interrompe requisições ativas e faz flush do exporter compartilhado dentro de um único prazo. O prazo padrão é 5 segundos. O descarte começa depois desse prazo operacional e sempre é aguardado, portanto o tempo total de `app.close()` pode exceder o prazo para garantir a liberação dos recursos. Falhas de drain, interrupção, flush ou descarte são reportadas como `TelemetryShutdownError` com código `OBS_TELEMETRY_SHUTDOWN_FAILED` depois da tentativa de descarte.

O suporte usa NestJS com Express. O adapter não declara suporte ao Fastify.

## Adapter de correlação com eventos amplos

`createRequestWideEventTraceCorrelation` adapta um logger de evento amplo que oferece `set`. Passe o resultado em `requestWideEventTraceCorrelation` nas opções habilitadas de `TelemetryModule` ou `TelemetryInterceptor`. Somente as declarações públicas desse contrato de correlação, incluindo a factory, a classe e seus tipos auxiliares, são livres de referências a Effect. Essa garantia não descreve todas as exportações do entrypoint NestJS. O pacote não depende de evlog em runtime.

Use `evlogAdapter` como o adapter oficial de eventos na composição de `createNodeObservability` ou `createNodeObservabilityFromConfig`. O adapter instala e encerra o logger global. `installGlobalLogger: true` aplica propriedade exclusiva com semântica de última chamada e substitui qualquer logger evlog preexistente. A aplicação não deve chamar `initLogger`, criar outro drain OTLP nem registrar um segundo interceptor de correlação. O `TelemetryInterceptor` cria o único span de servidor e grava `traceId` e `spanId` no logger antes de executar o handler.

O evlog continua dono do AsyncLocalStorage, do evento por requisição e da amostragem. O adapter oficial é dono do drain. Configure `requestEventName` no adapter com um evento canônico de tipo `request` e use `EvlogModule.forRoot()` sem outro drain. O adapter valida o nome no startup e o anexa ao evento por requisição antes de validar o contrato. Uma substituição posterior do logger global marca o ciclo de vida como degradado. O fechamento não desabilita nem redefine o logger substituto.

Durante uma requisição instrumentada, o adapter de telemetria mantém a associação entre a requisição e o span no WeakMap, uma entrada no conjunto de requisições em voo e closures e listeners de ciclo de vida da resposta. A finalização por `finish`, `close`, cancelamento ou interrupção remove a associação, libera a entrada em voo e remove os listeners. O adapter de correlação não armazena requisições, loggers ou identificadores.

Rotas sem span ativo não recebem correlação. Um resolver que não encontra logger ou lança uma exceção é isolado e não altera a execução nem a resposta da requisição. Em sucesso, HTTP 4xx e defeitos, os identificadores já estão no evento quando a resposta finaliza. Em cancelamento ou fechamento prematuro, eles permanecem no evento emitido no `close`. Um pai remoto não amostrado ainda fornece os identificadores ao evento, embora o span não seja exportado. Um `traceparent` malformado inicia um novo trace local.

`log.fork()` cria um logger e um evento amplo filho em background. O filho não herda automaticamente `traceId` nem `spanId` gravados no logger da requisição original. Quando um filho precisa de correlação, o consumidor deve fornecê-la explicitamente no próprio logger filho.

Guards do Nest executam antes dos interceptors. Uma rejeição de guard não cria o span de servidor deste interceptor e não recebe a correlação deste adapter. Consumidores que precisam cobrir rejeições de guard devem instrumentar esse caminho separadamente.

O drain OTLP do logger deve mapear os campos superiores `traceId` e `spanId` para os campos nativos do LogRecord. Copiar esses valores apenas para atributos arbitrários não atende ao contrato de correlação.

## Limite de erros

Use `NestErrorBoundaryModule.forRoot` junto de `TelemetryModule`. O módulo registra um filtro global, não um interceptor. `TelemetryInterceptor` continua sendo o único dono do span HTTP.

A configuração recebe um catálogo criado por `defineErrorCatalog`. O prefixo `_prefix` segue a gramática aceita por essa factory e deve ser não vazio. Prefixos que começam com `OBS_`, sem distinção entre maiúsculas e minúsculas, são reservados aos pacotes da plataforma. Uma configuração inválida falha imediatamente com `InvalidNestErrorCatalog` e código `OBS_NESTJS_ERROR_CATALOG_PREFIX_INVALID`. Cada declaração deve corresponder à lista `_codes` do catálogo. Código, status ou mensagem ausentes, além de qualquer divergência nessa lista, falham a construção com `InvalidNestErrorCatalogDeclaration`, código `OBS_NESTJS_ERROR_CATALOG_INVALID` e o código de catálogo afetado.

O limite usa uma classificação fechada com três resultados.

| Resultado          | Origem                                                                 | Resposta                                                                                               | Evento e captura                                                                        |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `ExpectedError`    | Código e declaração presentes no catálogo configurado                  | Status e mensagem declarados no catálogo, código estável, `request_id` e `trace_id` quando disponíveis | Anexa o erro ao evento amplo e nunca captura no Sentry                                  |
| `UnexpectedDefect` | `HttpException` 5xx com causa que não é outra `HttpException`          | Resposta 500 segura com correlação                                                                     | Emite um evento `defect` e tenta uma captura no Sentry quando configurado               |
| `HttpOutcome`      | Demais `HttpException`, identificadas pelo contrato estrutural público | Preserva `getStatus()` e `getResponse()`                                                               | Anexa o resultado ao evento amplo e nunca emite evento de defeito nem captura no Sentry |
| `UnexpectedDefect` | Demais erros e valores lançados                                        | Resposta 500 segura com correlação                                                                     | Emite um evento `defect` e tenta uma captura no Sentry quando configurado               |

A mensagem pública de `ExpectedError` sempre vem da declaração do catálogo. Mensagens constantes ignoram uma substituição na instância. Mensagens com template usam o texto que o `defineErrorCatalog` renderizou com os argumentos declarados. Uma substituição de `status` na instância lançada continua disponível para diagnóstico, mas não altera a resposta pública.

`NotFoundException`, `ForbiddenException`, `BadRequestException` de pipes e as demais subclasses de `HttpException` são resultados HTTP esperados. Isso inclui o 404 criado pelo Nest para uma rota inexistente. Uma `HttpException` 4xx continua sendo um resultado HTTP mesmo quando carrega uma causa não HTTP. Uma `HttpException` 5xx lançada deliberadamente pela aplicação também é um resultado HTTP esperado. Somente uma `HttpException` 5xx com uma `cause` que não é outra `HttpException` é classificada como defeito.

O limite responde antes de aguardar `recordDefect` e `SentryDefects`. Falhas síncronas e assíncronas desses destinos são isoladas e assentadas sem alterar a resposta. Quando os headers já foram enviados, o adapter HTTP encerra a resposta como `BaseExceptionFilter`.

A marca de captura pertence à requisição. Dois filtros que tratam a mesma instância na mesma requisição produzem um evento e uma tentativa de captura. Requisições diferentes que recebem a mesma instância produzem seus próprios eventos e tentativas. A decisão de deduplicação ocorre antes de anexar o erro ao evento amplo.

Quando o perfil desabilita Sentry, omita `sentryDefects`. O evento de defeito continua obrigatório.

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
