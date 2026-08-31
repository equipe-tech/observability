# Adaptadores Sentry

`@equipe-tech/observability-sentry` captura somente envelopes `UnexpectedDefect`. O entrypoint `/node` registra a capacidade `defects` no estágio `server`. O entrypoint `/browser` oferece um reporter imperativo sem registro de adapter.

Os dois entrypoints usam `sanitizeDefectEnvelope` pelo subpath neutro `@equipe-tech/observability/policy`. O evento enviado é reconstruído com uma lista fechada. Ela contém identidade de serviço, ambiente, release, código do erro, correlação, fingerprint, mensagem e stack sanitizados. A identidade e a correlação canônicas substituem tags homônimas da aplicação. Request bodies, headers, cookies, usuário, breadcrumbs, anexos, módulos, contextos desconhecidos, prompts, conteúdo de LLM e dados de pagamento não entram no evento.

Construa o envelope pela API pública e capture somente em limites de erro controlados pela aplicação:

```ts
import { unexpectedDefect } from "@equipe-tech/observability/policy";

const envelope = unexpectedDefect({
  error,
  code: "OBS_CHECKOUT_UNEXPECTED",
});

reporter.capture({ envelope });
```

O adapter não instala handlers globais. O chamador continua dono dos limites `catch`, `unhandledRejection` e `error` do browser. Essa escolha evita captura automática de erros operacionais esperados.

O Node usa `LightNodeClient` de `@sentry/node-core/light`. O pacote não chama o inicializador global do SDK e não configura tracing. Integrações padrão ficam desativadas.

A deduplicação combina identidade do envelope e fingerprint normalizado. A mesma instância permanece deduplicada por identidade depois que a janela do fingerprint vence. A janela e a capacidade têm limites configuráveis. `flushDeadlineMillis` limita somente a espera do chamador. Cada reserva tem um prazo terminal separado, `terminalSettlementDeadlineMillis`. Uma resposta HTTP 2xx tardia confirma a captura e mantém a deduplicação. Uma resposta não 2xx, falha de rede, drop anterior ao transporte ou prazo terminal vencido libera a reserva e permite nova tentativa.

`capture` retorna `queued` quando o SDK aceitou o evento na fila local. Isso não confirma entrega. `reports().reasons.captured` cresce somente após uma resposta HTTP 2xx para o evento exato. `reports()` contém contagens, horários e motivos. Esses dados descrevem decisões desta instância e não substituem recibos do servidor.

`sendVerificationDefect` retorna o `eventId` gravado no envelope e só emite `flushed: true` quando esse evento recebeu uma resposta HTTP 2xx e o flush terminou dentro do prazo. Cada reporter serializa essas verificações para que uma chamada aguarde o flush iniciado pelo próprio evento. Supressão retorna `suppressed` ou `deduplicated`. Respostas não 2xx, drop do SDK, falha de rede e timeout retornam `{ kind: "failed", reason: "transport" }`. Um timeout de verificação não declara rejeição do transporte. O adapter continua acompanhando a resposta até o prazo terminal sem manter timers ativos depois do assentamento.

No browser, DSN ausente ou inválido é erro, exceto com `disabled: true`. O modo desabilitado retorna supressão `disabled` e não cria cliente. `flush` pode ser repetido antes do fechamento. `close` e `dispose` são idempotentes. A instância entra no estado fechado antes de aguardar o SDK. Capturas feitas durante o hook de fechamento do adapter retornam supressão `closed` e não enviam eventos. No runtime Node, estágios ordenados anteriores podem executar antes do início desse hook.

As definições compiladas não referenciam tipos de provider. Instale somente o peer do entrypoint usado. Node requer `@sentry/node-core@10.72.0`. Browser requer `@sentry/browser@10.72.0`.

## Source maps

`sentrySourceMapUpload` produz a lista exata de argumentos de `sentry-cli sourcemaps upload`. O plano rejeita documentos malformados, chaves desconhecidas, valores que começam com `-` e caracteres de controle. `authToken` não pertence ao documento. O plano insere `--` antes dos caminhos e nunca contém token. Defina `SENTRY_AUTH_TOKEN` somente no ambiente do processo do CLI.

## Migração

Substitua inicialização direta do Sentry pelo adapter do runtime. Passe o mesmo `service.version` usado pelo OpenTelemetry como release e o ambiente canônico como environment. Mova políticas de browser para `@equipe-tech/observability/policy` para evitar importar os exportadores OTLP do entrypoint raiz.

## Composição React

`@equipe-tech/observability-react` chama o reporter de browser com deduplicação delegada. A entrada React toma uma decisão de deduplicação e uma decisão de política para o Sentry e para o evento operacional. O `event_id` do Sentry também é o `browser.event.id`. O reporter não instala handlers globais e não habilita tracing ou replay.
