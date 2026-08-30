# Referência da política de dados

O pacote de telemetria compila uma única `DataPolicy` aditiva durante o bootstrap. A política compilada sanitiza os sinais do servidor antes que um exportador OTLP os receba.

## Declaração da política

Use `definePolicy` para preservar as definições literais dos atributos. Use nomes em minúsculas, separados por pontos e com no máximo 128 caracteres.

```ts
import { definePolicy } from "@equipe-tech/observability";

export const policy = definePolicy({
  attributes: {
    "customer.tier": {
      classification: "public",
      required: false,
      metricLabel: true,
    },
    "customer.email": {
      classification: "sensitive",
      required: false,
      metricLabel: false,
    },
  },
  blockedKeys: [],
  blockedValuePatterns: [],
});
```

`parseDataPolicy` compila a declaração. A compilação soma as regras da aplicação às regras básicas imutáveis. Uma aplicação não pode remover uma regra básica de chave ou valor. Expressões de valores bloqueados da aplicação usam as flags global e case-insensitive, portanto todas as ocorrências são substituídas.

As expressões da aplicação usam uma gramática conservadora. Ela aceita literais, pontuação escapada, classes de caracteres, os anchors `^` e `$` e quantificadores diretos `?`, `*`, `+`, `{n}`, `{n,}` e `{n,m}`. `?`, `*`, `+`, `{n,}` e `{n,m}` são quantificadores variáveis. Cada expressão aceita no máximo um quantificador variável. Repetições fixas `{n}` podem aparecer mais de uma vez. Todo limite numérico deve ser no máximo 64. A fonte aceita no máximo 256 caracteres e a soma das larguras de repetições fixas `{n}` não pode passar de 128. A compilação rejeita grupos, alternância, lookarounds, backreferences, curingas sem escape, quantificadores encadeados, classes incompletas, limites maiores que 64, fontes maiores que 256 caracteres, larguras fixas totais maiores que 128 e múltiplos quantificadores variáveis antes de construir um `RegExp`. Padrões como `(a|aa)+$`, `[a-z]+[a-z]+x`, `[a-z]{0,200}[a-z]{0,200}[a-z]{0,200}x` e quatro repetições de `[A-Za-z0-9]{0,64}` seguidas de `x` falham com um código `OBS_POLICY_UNSAFE_*` sem incluir o padrão no diagnóstico.

Políticas antigas com faixas encadeadas precisam manter uma única faixa variável. Fixe as outras repetições na largura definida pelo contrato do identificador. Para um sufixo de oito dígitos, migre `prefix_[A-Za-z]{1,32}_[0-9]{1,8}` para `prefix_[A-Za-z]{1,32}_[0-9]{8}`. Quando o contrato aceita várias larguras, normalize o identificador antes da telemetria ou declare uma regra separada para cada largura fixa necessária.

## Classificações

A política aceita estas classificações:

- `public` permite um valor escalar estável.
- `internal` permite um valor escalar estável.
- `sensitive` mascara valores de logs, eventos, spans, defeitos e recursos como `****`.
- `forbidden` rejeita um valor declarado pelo produtor ou descarta um valor não confiável.

Labels de métricas nunca recebem valores mascarados. A facade de métricas rejeita labels bloqueadas com o código `POLICY_BLOCKED` de `MetricsError`. O campo `policyReason` identifica a categoria segura da rejeição sem carregar a chave ou o valor. Uma métrica Effect direta descarta a label durante a coleta e informa a mesma razão no resultado do flush. `service.instance.id` continua sendo uma falha obrigatória na exportação direta de métricas.

O logger do pacote é a fronteira da política para registros Effect e saídas delegadas. As aplicações devem registrar loggers delegados pelo caminho de composição da observabilidade para que o pacote sanitize cada registro primeiro. Não adicione um logger bruto depois da layer de observabilidade, pois ele receberia o registro Effect sem sanitização.

## Falhas seguras

`InvalidDataPolicy` agrega problemas da política sob `OBS_POLICY_INVALID`. Cada problema usa um código fechado e contexto seguro e limitado. Ele nunca contém um valor rejeitado.

O bootstrap envolve `InvalidDataPolicy` em `InvalidObservabilityConfig`. O wrapper usa `field: "policy"` e mantém o erro agregado como causa.

A ingestão do browser não rejeita um batch válido por causa de um campo que viola a política. A resposta informa contagens limitadas de `accepted`, `redacted` e `dropped`.

## Nomes de atributos

Logs, spans, eventos de contrato, eventos de span, defeitos, recursos e métricas aceitam apenas nomes em minúsculas separados por pontos. Cada nome precisa de pelo menos dois segmentos. Os segmentos começam com uma letra minúscula e contêm letras minúsculas, números ou sublinhados. A política descarta atributos da aplicação como `requestId`, `userId` e `component` em vez de normalizá-los. Campos Effect gerados pelo pacote usam nomes canônicos como `effect.fiber.id`, `effect.log.level` e `effect.log_span.database` antes da validação.

## Limites dos sinais

Eventos do browser mantêm no máximo 32 campos e 1.024 caracteres por valor. Eventos do servidor mantêm 128 campos e 16.384 caracteres por valor. Logs e spans mantêm 128 campos e 32.768 caracteres por valor. Um span mantém os primeiros 128 eventos e os primeiros 128 links. O OTLP informa as contagens exatas de atributos, eventos e links descartados após a aplicação da política e dos limites. Contexto de defeito e o mapa completo de tags mantêm 128 campos cada. Textos de defeito e stack traces mantêm 65.536 caracteres. Recursos mantêm 128 atributos e 8.192 caracteres por valor. Métricas mantêm 16 labels e 64 caracteres por label textual. Chaves de métricas exigem nomes separados por pontos. Os identificadores reservados `unit`, `time_unit`, `service.instance.id`, `trace.id`, `span.id`, `user.id` e `session.id` são proibidos. Cada label aceita no máximo 100 valores distintos durante a vida do instrumento.

A rejeição de política das métricas usa `POLICY_BLOCKED`. Limites de cardinalidade e quantidade de campos usam `LIMIT_EXCEEDED`.

O truncamento no servidor preserva o prefixo limitado. O pacote limita cada texto antes de executar scanners ou expressões da aplicação. O trecho removido não entra em um scanner nem em um buffer de sinal. Decisões da política emitem `rule: "bounds"` com `action: "truncated"` ou `action: "dropped"`. O campo `dropped` conta cada campo removido pela política ou pelos limites.

`layer`, `layerOtlp` e `layerFromEnv` aceitam `resourceAttributes`. A construção da layer combina atributos adicionais de recurso depois da classificação da política. Chaves canônicas ou da aplicação duplicadas interrompem a construção com `OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE`.

## Entrega para o adapter de defeitos

A OBS-61 é dona dos adapters Sentry. O adapter deve cumprir estes requisitos:

- Capturar apenas valores `UnexpectedDefect`.
- Definir `sendDefaultPii` como `false`.
- Executar `sanitizeDefectEnvelope` em `beforeSend`.
- Retornar `null` quando `sanitizeDefectEnvelope` retornar `Option.none`.

`Option.none` é obrigatório quando um contexto ou uma tag proibida produziria um envelope parcial.

- Preservar as tags de correlação aprovadas pela política.

`sanitizeDefectEnvelope` não depende do destino. O pacote de telemetria não importa um SDK Sentry.
