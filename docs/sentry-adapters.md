# Adaptadores Sentry

`@equipe-tech/observability-sentry` captura somente envelopes `UnexpectedDefect`. O entrypoint `/node` registra a capacidade `defects` no estágio `server`. O entrypoint `/browser` oferece um reporter imperativo sem registro de adapter.

Os dois entrypoints usam `sanitizeDefectEnvelope` pelo subpath neutro `@equipe-tech/observability/policy`. O evento enviado é reconstruído com uma lista fechada. Ela contém identidade de serviço, ambiente, release, código do erro, correlação, fingerprint, mensagem e stack sanitizados. Request bodies, headers, cookies, usuário, breadcrumbs, anexos, módulos, contextos desconhecidos, prompts, conteúdo de LLM e dados de pagamento não entram no evento.

O Node usa `LightNodeClient` de `@sentry/node-core/light`. O pacote não chama o inicializador global do SDK e não configura tracing. Integrações padrão e handlers globais ficam desativados.

A deduplicação combina identidade do envelope e fingerprint normalizado. A janela e a capacidade têm limites configuráveis. `reports()` retorna somente contagens, horários e motivos.

`sendVerificationDefect` retorna o `eventId` gravado no envelope e só emite `flushed: true` quando esse evento recebeu uma resposta HTTP 2xx e o flush terminou dentro do prazo. Supressão, respostas não 2xx, falha de rede e timeout retornam uma falha de transporte. `flush` pode ser repetido antes do fechamento. `close` e `dispose` são idempotentes. Depois que o fechamento do SDK termina, inclusive com `false` ou timeout, o reporter permanece fechado e novas capturas são suprimidas. O fechamento não é repetido porque o SDK desabilita o cliente na primeira chamada.

## Source maps

`sentrySourceMapUpload` produz a lista exata de argumentos de `sentry-cli sourcemaps upload`. O plano nunca contém token. Defina `SENTRY_AUTH_TOKEN` somente no ambiente do processo do CLI.

## Migração

Substitua inicialização direta do Sentry pelo adapter do runtime. Passe o mesmo `service.version` usado pelo OpenTelemetry como release e o ambiente canônico como environment. Mova políticas de browser para `@equipe-tech/observability/policy` para evitar importar os exportadores OTLP do entrypoint raiz.
