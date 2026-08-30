# @equipe-tech/observability-evlog

Adapter oficial de eventos para `@equipe-tech/observability`.

```ts
import { Effect } from "effect";
import { createNodeObservability } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";

const evlog = evlogAdapter();
const observability = await createNodeObservability({
  profile: "worker",
  env,
  contract,
  policy,
  adapters: [evlog.registration],
});

await observability.runtime.runPromise(
  producer.emit("job.completed", input).pipe(Effect.provide(observability.eventLayer)),
);
```

O adapter valida o contrato e aplica a política antes de inserir cada registro em `createDrainPipeline`. A fila usa limites independentes de quantidade e bytes serializados. Falhas terminais escrevem somente o registro já sanitizado como uma linha NDJSON em stdout.

A entrega compõe as APIs públicas `createDrainPipeline`, `sendBatchToOTLP`, `createError` e `defineErrorCatalog` do evlog 2.27.1. Eventos de defeito passam por `createError` antes da projeção dos campos estruturados `error.type`, `error.message` e `error.retryable`. `sendBatchToOTLP` mantém o scope fixo `evlog` sem versão. O encoder público serializa números inteiros como `intValue` e números fracionários como `stringValue`. O adapter não substitui esse encoder. A API pública não permite definir `droppedAttributesCount`, então o adapter grava a contagem pré-fila em `event.policy_dropped_attributes`.

O encoder público sempre gera `deployment.environment` a partir do evento evlog. Por isso, o modo `environmentAlias: "omitted"` ainda contém esse alias em logs, embora traces do núcleo o omitam. O adapter acrescenta `deployment.environment.name`, `service.namespace` e `service.instance.id` por `resourceAttributes`, que é o único mecanismo público suportado pelo encoder para esses campos.

`installGlobalLogger` usa `initLogger` com `silent: true`, `pretty: false` e `redact: false`. Eventos de contrato usam a layer do handle e continuam sendo exportados se outro código substituir o logger global. `drops()` informa somente contagens e timestamps. `total` é a soma de todas as razões e conta incidentes de perda, não eventos únicos. Se a entrega falhar e o fallback em stdout também falhar, as duas razões são contabilizadas.
