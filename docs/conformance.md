# Suíte de conformidade

`@equipe-tech/observability/testing` publica a suíte executável do padrão da plataforma. A aplicação compõe o runner com os providers de evidência dos adapters que usa. Cada provider chama a API dona da regra. O núcleo não reimplementa validação de manifesto, classificação NestJS, projeção Sentry, entrega evlog, ciclo React ou leitura de imports.

## Instalação

Instale o núcleo e somente os pacotes donos das capacidades da aplicação. Um worker com evlog e manifesto usa:

```sh
bun add -d @equipe-tech/observability @equipe-tech/observability-cli @equipe-tech/observability-evlog effect
```

Os helpers ficam nos entrypoints `/testing`. Entry points de produção não carregam a suíte.

## Execução

O alvo seleciona um perfil oficial, a topologia e as capacidades. Os providers entregam recibos seguros para os checks aplicáveis.

```ts
import { Effect, Option } from "effect";
import {
  conformanceTargetBinding,
  runConformance,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import {
  operationsManifestConformance,
  packageBoundaryConformance,
} from "@equipe-tech/observability-cli/testing";
import { evlogConformance } from "@equipe-tech/observability-evlog/testing";

const identity = {
  serviceName: "billing-worker",
  serviceVersion: "1.4.0",
  environment: "test",
};
const binding = conformanceTargetBinding(compiledContract, identity);

const target: ConformanceTarget = {
  name: "billing-worker",
  profile: "worker",
  environment: "test",
  topology: "local",
  capabilities: {
    traces: true,
    metrics: true,
    defects: false,
    browserIngest: false,
    audit: false,
  },
  binding,
  providers: [
    ...operationsManifestConformance({ manifest, contract: contractIndex }),
    packageBoundaryConformance({ projectRoot, sourceRoots: ["src"] }),
    evlogConformance({
      delivery: Option.getOrThrow(evlog.delivery(runId, "billing.run")),
      drops: evlog.drops(),
      destination: destinationReceipt,
      runId,
      eventName: "billing.run",
    }),
    ...telemetryProviders,
  ],
};

const report = await Effect.runPromise(runConformance(target));
```

`compiledContract`, `runId`, `evlog`, `destinationReceipt` e `telemetryProviders` são produzidos pelo kit da aplicação antes da execução. `destinationReceipt` vem da avaliação que executa a leitura do destino depois do Collector. O exemplo completo executável está em `observability/conformance/fixtures/positive/worker/kit.ts`. `telemetryProviders` reúne os providers do contrato, identidade, correlação, política, ciclo de vida e canário exportados pelo mesmo entrypoint do runner. Um provider aplicável ausente encerra a construção da suíte com `InvalidConformanceSuite`.

## Resultado

Checks seguem a ordem estável do catálogo. `not-applicable` continua visível e não é convertido em aprovação. Um relatório conformante não contém checks aplicáveis com status `fail`.

```json
{
  "target": "billing-worker",
  "profile": "worker",
  "conforms": false,
  "checks": [
    {
      "status": "fail",
      "id": "pipeline.no-application-otlp",
      "profile": "worker",
      "rule": {
        "document": "docs/coding-standards.md",
        "heading": "Fronteiras do monorepo"
      },
      "failure": {
        "code": "OBS_CONFORMANCE_LOCAL_OTLP_PIPELINE",
        "offendingValue": "src/telemetry.ts imports effect/unstable/observability"
      }
    }
  ]
}
```

Leia `failure.code`, `failure.offendingValue`, `rule.document` e `rule.heading` juntos. O código identifica o contrato estável. O valor aponta a evidência recusada. A referência identifica a regra que o consumidor deve corrigir.

## Catálogo de checks

| Check                              | Perfis ou condição                           | Regra                                                    |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `profile.official`                 | todos                                        | `docs/profiles.md`, `Perfis oficiais de observabilidade` |
| `identity.canonical`               | exceto `library`                             | `docs/profiles.md`, `Configuração de Node`               |
| `contract.compiles`                | todos                                        | `docs/telemetry-contract.md`, `Contrato de telemetria`   |
| `manifest.valid`                   | exceto `library`                             | `docs/operations-manifest.md`, `Manifesto de operações`  |
| `producers.contract-derived`       | perfis com eventos                           | `docs/telemetry-contract.md`, `Recibo de emissão`        |
| `queries.contract-derived`         | perfis com manifesto                         | `docs/operations-manifest.md`, `Queries gerenciadas`     |
| `correlation.canonical`            | perfis com eventos ou traces                 | `docs/telemetry-contract.md`, `Correlação tipada`        |
| `policy.compiles`                  | perfis com sinais de runtime                 | `docs/data-policy.md`, `Declaração da política`          |
| `server-events.evlog-collector`    | `nestjs-api`, `worker`, `cli`                | `docs/profiles.md`, `Configuração de Node`               |
| `sentry.unexpected-defects-only`   | capacidade `defects`                         | `docs/sentry-adapters.md`, `Adaptadores Sentry`          |
| `lifecycle.profile-compliant`      | todos                                        | `docs/profiles.md`, `Ciclo de vida`                      |
| `audit.durable-before-operational` | capacidade `audit`                           | `docs/audit.md`, `Ordem durável`                         |
| `pipeline.no-application-otlp`     | todos                                        | `docs/coding-standards.md`, `Fronteiras do monorepo`     |
| `canary.telemetry-destination`     | runtimes Node ou traces/metrics selecionados | `docs/testing.md`, `Canário do pipeline`                 |
| `canary.sentry`                    | capacidade `defects`                         | `docs/sentry-adapters.md`, `Adaptadores Sentry`          |
| `canary.browser-route`             | capacidade `browserIngest`                   | `docs/profiles.md`, `Runtime React web`                  |
| `canary.audit`                     | capacidade `audit`                           | `docs/audit.md`, `Ordem durável`                         |

## Recibos e topologia

Recibos podem conter IDs de execução, digests de manifesto, IDs de evento e resumos limitados. Não inclua credenciais, DSNs, payloads de provider, documentos de auditoria, stacks ou dados pessoais.

Na topologia `local`, `startLocalCollectorDestination` inicia o Collector isolado, executa a leitura do destino e emite o recibo depois da observação. Captura direta no endpoint do exporter não pode emitir esse recibo. Na topologia `deployed`, a aplicação executa seus probes e passa a função de leitura para `applicationDeployedTelemetryDestinationReceipt`. O recibo identifica essa confiança como `application-supplied-readback`, em vez de representar a observação como verificação independente da suíte. Os dois caminhos copiam a observação e devolvem fatos imutáveis vinculados à topologia, ao run ID e à identidade de resource. A suíte não carrega credenciais, não consulta Axiom ou Sentry diretamente e não altera recursos de provider.

O recibo de produtor carrega a proveniência da definição completa do contrato. Nome de evento, índice de consulta ou tipo de evento isolados não substituem essa proveniência.

Signals selecionados sempre exigem avaliação. O fixture `react-web` em `observability/conformance/fixtures/positive/react-web/kit.ts` cria traces e métricas pelo runtime React, envia o lote pela rota NestJS e exige leitura no destino depois do Collector. Quando a correlação de execução usa um atributo de contrato em vez do campo canônico `run.id`, passe `eventRunIdAttribute` e `metricRunIdAttribute` para `telemetryCanaryConformance`. Toda seleção de `browserIngest`, inclusive em `nestjs-api`, exige `canary.browser-route`.

Use `assertConforms` para transformar um relatório recusado em falha de teste. Use `assertConformanceFailure` em fixtures negativas para exigir o check discriminante exato.
