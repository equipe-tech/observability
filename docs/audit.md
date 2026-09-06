# Auditoria no servidor

`@equipe-tech/observability` define o registro de auditoria e a cópia operacional. A aplicação continua dona do ledger, da transação, da retenção e do catálogo de ações.

## Contrato

Cada ação em `auditActions` declara `action`, `resourceType`, `allowedOutcomes` e um catálogo opcional `reasonCodes`. `AuditOutcome` aceita `success`, `failure`, `cancelled` e `denied`. `EventOutcome` continua aceitando somente `success`, `failure` e `cancelled`. `action` aceita de 3 a 128 caracteres e exige pelo menos dois segmentos separados por ponto. Cada segmento começa com uma letra minúscula e continua com letras minúsculas, números ou sublinhados. `resourceType` aceita de 1 a 64 caracteres sem controles e usa a mesma gramática de segmento, mas também aceita um único segmento.

`parseAuditRecord` recebe o ID do recurso. O parser deriva o tipo do recurso pela ação selecionada. O parser também limita identificadores, rejeita caracteres de controle e verifica o resultado e o código de razão. `occurredAt` aceita somente RFC 3339 UTC canônico com três dígitos de milissegundos, como `2026-01-02T03:04:05.000Z`. O registro não aceita email, nome de exibição, razão livre, metadata, snapshots de mudança, patches ou objetos da aplicação.

O ator é um snapshot imutável. A publicação não consulta um serviço de identidade. Se o chamador omitir `correlation`, o parser usa `CurrentCorrelation`.

## Ordem durável

Grave o ledger da aplicação antes da cópia operacional.

```ts
const record = yield * parseAuditRecord(contract, input);
const result = yield * recordAudit(record, (document) => durableLedgerWrite(document));
```

`commitAuditRecord` cria `committedAt`, calcula o hash e entrega um único `AuditCommitDocument` plano ao callback durável. A aplicação persiste exatamente esse documento junto ao ledger na mesma operação atômica. A função só constrói `CommittedAuditRecord` depois que o callback termina com sucesso. O tipo não tem construtor público. Uma falha do ledger mantém o canal de erro original e não publica uma cópia.

`recordAudit` devolve o valor do ledger, o registro comprometido e o recibo de publicação. A publicação não falha no canal Effect. O recibo é `published`, `deduplicated` ou `dropped`. `published` confirma a admissão na fila, não a entrega ao transporte. Uma falha terminal posterior incrementa `dropped` e o motivo terminal. Por isso, `published` e `dropped` podem contar o mesmo registro e não são contadores mutuamente exclusivos. Os motivos de descarte são `unbound`, `closed`, `queue-overflow`, `contract-rejected`, `policy-rejected` e `transport`. `contract-rejected` indica que o valor não é um `CommittedAuditRecord` criado pelo pacote ou que a ação, o tipo de recurso derivado, o resultado ou o código de razão não pertence ao contrato do adapter. O relatório registra somente a contagem e os timestamps desse descarte.

## Outbox da aplicação

`AuditOutbox` é uma porta de armazenamento. A aplicação persiste o `AuditCommitDocument` recebido pelo callback como JSON e implementa `claim` e `settle` sobre a própria tabela. `claim` devolve uma chave opaca `AuditOutboxClaimKey` e um documento plano. `drainAuditOutbox` valida o documento, `committedAt` e o hash antes de restaurar o registro comprometido dentro do pacote. Um documento inválido ou adulterado é entregue a `settle` como `quarantined`, entra no relatório e não impede a publicação dos próximos itens. Erros e relatórios não incluem dados do documento. Uma aplicação pode fechar o processo, reabrir a tabela e drenar sem manter objetos em memória. O código de produção do núcleo e dos adapters não importa bibliotecas de banco de dados.

Use `recordId` como a única chave de idempotência. Uma repetição dentro da janela do adapter retorna `deduplicated`. Esse resultado não conta como perda. Uma rejeição da fila ou um descarte terminal libera a reserva para uma tentativa posterior.

## Cópia operacional

Um evento comum de contrato com `kind: "audit"` passa por `EventProducer.emit` e pelo pipeline normal de eventos. Esse evento não tem a ordem durável, o ID, o hash nem as âncoras da cópia operacional. A cópia operacional aceita somente um `CommittedAuditRecord` criado e marcado pelo pacote depois da gravação durável. `Contract.organizationEvents.AuditRecorded` registra o formato exigido no startup, mas emitir esse alias pelo `EventProducer` ainda produz um evento comum.

O adapter evlog existente fornece `observability.auditLayer`. A cópia usa a mesma fila, os mesmos limites, retry, fallback, flush, close e contagem de perdas dos eventos.

Um contrato que declara `auditActions` também deve registrar `Contract.organizationEvents.AuditRecorded` em `events` antes de iniciar o adapter. O evento deve ser obrigatório, usar amostragem `always`, severidade `info` e zero atributos customizados. Sem esse contrato exato, o startup falha com `OBS_EVLOG_AUDIT_CONTRACT_INVALID`.

A política sanitiza todos os campos antes da fila e a projeção nativa lê somente o resultado transformado. A superfície `audit` aceita no máximo 64 campos e 4.096 caracteres por texto. Nove âncoras são imutáveis: `event.outcome`, `event.timestamp`, `audit.record.id`, `audit.record.hash`, `audit.action`, `audit.actor.kind`, `audit.resource.type`, `audit.outcome` e `audit.schema_version`. Se a política remover ou alterar uma dessas âncoras, o adapter descarta a cópia inteira como `policy-rejected`. Três campos obrigatórios não são âncoras: `audit.actor.id`, `audit.resource.id` e `audit.occurred_at`. A política pode mascará-los, mas não removê-los. A política pode remover os campos opcionais `audit.reason_code`, `audit.tenant.id`, `request.id`, `run.id`, `trace.id` e `span.id`. O envelope nativo recebe os mesmos valores mascarados ou removidos dos campos canônicos.

A projeção nativa usa estes mapeamentos:

| Valor canônico        | Valor evlog         |
| --------------------- | ------------------- |
| ator `user`           | ator `user`         |
| ator `service`        | ator `api`          |
| ator `system`         | ator `system`       |
| resultado `success`   | resultado `success` |
| resultado `failure`   | resultado `failure` |
| resultado `cancelled` | resultado `failure` |
| resultado `denied`    | resultado `denied`  |

`audit.outcome` sempre preserva o valor canônico. `event.outcome` é `success` somente para sucesso. Os outros resultados usam `failure`. O adapter mapeia `recordId` para `audit.record.id` e para `audit.idempotencyKey`. IDs de request, run, trace e span só aparecem quando o contexto contém esses valores.

## Integridade

`canonicalAuditPayload` serializa o registro e `committedAt` em ordem estável. `AuditDigest` é a porta neutra de hash. `layerNodeAuditDigest`, no entrypoint `./node`, usa SHA-256.

`EvlogAdapterOptions.auditIntegrity` ativa a assinatura nativa somente para auditorias. Use `strategy: "hash-chain"` para encadear cópias ou `strategy: "hmac"` com um secret. O adapter não inclui o secret em erros, relatórios ou logs.

A aplicação pode guardar o mesmo hash no ledger e comparar o valor com `audit.record.hash`. Essa comparação detecta divergência entre o ledger e a cópia operacional. O pacote não torna um banco de dados da aplicação resistente a alterações.

Relatórios contêm somente contagens, motivos e timestamps. Eles não contêm registros, IDs, códigos de razão, hashes, respostas de provedor ou secrets. A API de auditoria existe somente nos entrypoints de servidor. Os pacotes browser e React não a exportam.

A chamada direta `log.audit()` do logger global não implementa o contrato de ação nem a ordem durável e não é suportada. O adapter a rejeita como descarte contado e não envia o envelope de auditoria.
