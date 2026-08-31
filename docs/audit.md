# Auditoria no servidor

`@equipe-tech/observability` define o registro de auditoria e a cópia operacional. A aplicação continua dona do ledger, da transação, da retenção e do catálogo de ações.

## Contrato

Cada ação em `auditActions` declara `action`, `resourceType`, `allowedOutcomes` e um catálogo opcional `reasonCodes`. `AuditOutcome` aceita `success`, `failure`, `cancelled` e `denied`. `EventOutcome` continua aceitando somente `success`, `failure` e `cancelled`.

`parseAuditRecord` recebe o ID do recurso. O parser deriva o tipo do recurso pela ação selecionada. O parser também limita identificadores, rejeita caracteres de controle e verifica o resultado e o código de razão. O registro não aceita email, nome de exibição, razão livre, metadata, snapshots de mudança, patches ou objetos da aplicação.

O ator é um snapshot imutável. A publicação não consulta um serviço de identidade. Se o chamador omitir `correlation`, o parser usa `CurrentCorrelation`.

## Ordem durável

Grave o ledger da aplicação antes da cópia operacional.

```ts
const record = yield * parseAuditRecord(contract, input);
const result = yield * recordAudit(record, durableLedgerWrite);
```

`commitAuditRecord` só constrói `CommittedAuditRecord` depois que `durableLedgerWrite` termina com sucesso. O tipo não tem construtor público. Uma falha do ledger mantém o canal de erro original e não publica uma cópia.

`recordAudit` devolve o valor do ledger, o registro comprometido e o recibo de publicação. A publicação não falha no canal Effect. O recibo é `published`, `deduplicated` ou `dropped`. Os motivos de descarte são `unbound`, `closed`, `queue-overflow`, `policy-rejected` e `transport`.

## Outbox da aplicação

`AuditOutbox` é uma porta de armazenamento. A aplicação implementa `claim` e `settle` sobre a própria tabela. `drainAuditOutbox` publica cada registro comprometido por `AuditPublisher` e entrega o recibo a `settle`. O código de produção do núcleo e dos adapters não importa bibliotecas de banco de dados.

Use `recordId` como a única chave de idempotência. Uma repetição dentro da janela do adapter retorna `deduplicated`. Esse resultado não conta como perda. Uma rejeição da fila ou um descarte terminal libera a reserva para uma tentativa posterior.

## Cópia operacional

O adapter evlog existente fornece `observability.auditLayer`. A cópia usa a mesma fila, os mesmos limites, retry, fallback, flush, close e contagem de perdas dos eventos.

A política sanitiza todos os campos antes da fila. A superfície `audit` aceita no máximo 64 campos e 4.096 caracteres por texto. Se a política remover um campo obrigatório do ator ou do recurso, o adapter descarta a cópia inteira como `policy-rejected`.

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

`canonicalAuditPayload` serializa o registro em ordem estável. `AuditDigest` é a porta neutra de hash. `layerNodeAuditDigest`, no entrypoint `./node`, usa SHA-256.

`EvlogAdapterOptions.auditIntegrity` ativa a assinatura nativa somente para auditorias. Use `strategy: "hash-chain"` para encadear cópias ou `strategy: "hmac"` com um secret. O adapter não inclui o secret em erros, relatórios ou logs.

A aplicação pode guardar o mesmo hash no ledger e comparar o valor com `audit.record.hash`. Essa comparação detecta divergência entre o ledger e a cópia operacional. O pacote não torna um banco de dados da aplicação resistente a alterações.

Relatórios contêm somente contagens, motivos e timestamps. Eles não contêm registros, IDs, códigos de razão, hashes, respostas de provedor ou secrets. A API de auditoria existe somente nos entrypoints de servidor. Os pacotes browser e React não a exportam.
