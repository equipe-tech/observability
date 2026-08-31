# observability

Plataforma de observabilidade da Equipe Tech. Um contrato OpenTelemetry, um Collector por stack e adapters para cada runtime. O mesmo pipeline roda no desenvolvimento local e na produção.

> Status: pipeline local, adapters por runtime e provisionamento implementados. A CLI também cria datasets, tokens Axiom e projetos Sentry por ambiente.

## Princípios

- OpenTelemetry como contrato: OTLP, W3C Trace Context e semantic conventions.
- A aplicação conhece somente um endpoint OTLP. Ela não conhece Axiom, Sentry ou outro backend.
- Wide events complementam os traces. Uma operação gera um root span, child spans nas fronteiras e um wide event de conclusão.
- Paridade local: o Collector fica entre a aplicação e o destino em todos os ambientes.
- Transferível: um projeto muda de dono com troca de endpoints e credenciais, sem mudança de código.

## Arquitetura

```text
Browser
  +--> Sentry frontend (SDK nativo)
  +--> /_telemetry/events (API do projeto)
              |
API + Workers + Jobs
  +--> OTel Collector (sidecar por stack)
              |
              +--> Axiom logs
              +--> Axiom traces
              +--> Axiom metrics

Backend exceptions --> Sentry backend (SDK nativo)
```

| Componente | Responsabilidade                                         |
| ---------- | -------------------------------------------------------- |
| Pacote     | Instrumentação, contrato de eventos, contexto e adapters |
| Collector  | Redação, batch, retry, roteamento e enriquecimento       |
| Axiom      | Logs, traces, métricas, dashboards e monitores           |
| Sentry     | Exceções, releases, source maps e Session Replay         |
| Cloudflare | Tunnel, WAF, rate limit e correlação via `CF-Ray`        |

## Ambientes

### Local

```text
app -> otel-collector -> otel-desktop-viewer
```

O [otel-desktop-viewer](https://github.com/CtrlSpice/otel-desktop-viewer) recebe os três sinais por OTLP e publica somente em loopback.

### Produção

```text
app -> otel-collector (Kamal accessory) -> Axiom
```

O Collector roda como accessory do [Kamal](https://kamal-deploy.org), com filas persistentes limitadas por sinal e sem porta OTLP pública. Saúde e métricas internas são publicadas somente em loopback. Consulte [Operar a fila persistente do Collector](docs/collector-production-operations.md) antes do primeiro deploy.

## Estrutura

```text
packages/
  telemetry/          @equipe-tech/observability: núcleo neutro, contratos, política, identidade e lifecycle
  evlog/              @equipe-tech/observability-evlog: eventos tipados com fila e entrega OTLP do evlog
  sentry/             @equipe-tech/observability-sentry: captura sanitizada de defeitos Node e browser
  react/              @equipe-tech/observability-react: runtime React web, listeners e entrega coordenada
  nestjs/             @equipe-tech/observability-nestjs: integração HTTP e lifecycle do NestJS
  cli/                observability dev|provision: CLI, assets da stack local e do Collector de produção
docs/                 padrões de código, erros, testes e workflow
tools/oxlint/         plugins de lint do projeto (anti-slop, effect)
repos/                repositórios vendorados para agentes (gitignored)
```

### Adapters

O núcleo `@equipe-tech/observability` publica entrypoints explícitos:

| Entrypoint         | Conteúdo                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `./effect`         | `WideEvent` e `layerWideEvent` para aplicações Effect                                             |
| `./metrics`        | Facade sem dependência de framework para counters, histogramas, gauges observáveis, flush e close |
| `./node`           | `runMain`, composição Node, lifecycle e ingestão de eventos do browser                            |
| `./browser`        | `BrowserTelemetry` compatível com Effect, com fila limitada, batch e transporte injetável         |
| `./browser/client` | Cliente imperativo do browser sem tipos Effect na API pública                                     |
| `./testing`        | Captura em memória dos exports OTLP reais para asserts de spans, logs e métricas                  |

A integração NestJS vive na raiz de `@equipe-tech/observability-nestjs`. Ela publica `TelemetryModule`, `TelemetryInterceptor`, `withRequestSpan`, `createBrowserEventsController` e a política HTTP. O adapter oficial de eventos vive em `@equipe-tech/observability-evlog` e fornece `registration`, `drops()` e `pending()`.

Os [adaptadores Sentry](docs/sentry-adapters.md) publicam entrypoints separados para Node e browser, uma política compartilhada e um plano de upload de source maps sem credenciais.

O [cliente imperativo do browser](docs/browser-client.md) publica `emit`, `flush`, `pending` e `dispose` sem tipos Effect e documenta o ciclo de vida React suportado. O contrato do endpoint `/_telemetry/events` vive em `BrowserEvents` no entrypoint raiz. O servidor faz o parse com `parseBrowserEventBatch` e re-emite os eventos como wide events com atributos de servidor (`event.source`, `browser.event.id`). O cliente sanitiza nomes e campos antes da fila conforme a [política de dados da telemetria do browser](docs/browser-telemetry-data-policy.md).

O pacote `@equipe-tech/observability-nestjs` publica o endpoint pronto. Registre `createBrowserEventsController(observability.runtime, { eventLayer: observability.eventLayer })` nos controllers do módulo. Assim, o endpoint usa o mesmo adapter de eventos do servidor. O controller responde `202 { accepted }` e rejeita batches inválidos com `400 { code, message, correlationId }`. O valor `correlationId` é um identificador seguro para suporte. O limite de corpo bruto pertence ao transporte HTTP; o Express responde `413` acima do limite configurado.

Consulte [Métricas sem dependência de framework](docs/metrics.md) para lifecycle, limites de cardinalidade, atributos e erros.

Consulte a [política de dados](docs/data-policy.md) para classificações, mascaramento, descartes e limites por sinal.

Consulte [Semântica HTTP do adapter NestJS](docs/nestjs-http-semantics.md) para rotas, status, proxy, privacidade e exclusões.

## Desenvolvimento

Requisitos: Bun `1.4+` e [Vite+](https://viteplus.dev) `0.3.0`.

```sh
bun install         # instala e habilita os hooks de git
bun repos:sync      # clona os repositórios vendorados em repos/
bun check           # lint (type-aware) + format + type-check
bun run build       # compila os pacotes e gera as declarações
bun run test        # testes
bun run test:package # valida os pacotes instalados fora do repositório
```

### Stack local

```sh
bun packages/cli/src/main.ts dev up       # sobe collector + viewer (UI em http://localhost:8000)
bun packages/cli/src/main.ts dev status   # estado da stack
bun packages/cli/src/main.ts dev down     # derruba a stack
```

A CLI copia os assets versionados para `OBSERVABILITY_HOME`. O diretório padrão é `~/.local/state/observability`.

### Provisionamento de produção

```sh
bun packages/cli/src/main.ts provision --dir ~/projeto --name meu-app
```

O comando escreve no projeto alvo:

- `observability/collector.yaml`: configuração do OTel Collector de produção (fila persistente e exporters Axiom)
- `observability/kamal.accessory.yml`: trecho de accessory para mesclar em `config/deploy.yml`, com os datasets `<name>-traces|logs|metrics`

O comando é idempotente. Um arquivo provisionado que foi modificado localmente gera o erro `OBS_CLI_PROVISION_CONFLICT`; use `--force` para sobrescrever. Depois do merge do accessory, prepare o filesystem dedicado de 8 GiB, valide owner `10001:10001` e mode `0700`, e defina o secret `AXIOM_TOKEN` no Kamal. Pare produtores antes de 75% de uso ou com menos de 2 GiB livres. O procedimento completo de health, alertas, drain, backup e rotação está em [Operar a fila persistente do Collector](docs/collector-production-operations.md).

### Ambientes remotos

A CLI autentica com Axiom e Sentry, cria recursos isolados por ambiente e salva as credenciais com modo `0600`. Datasets Axiom usam kinds específicos por sinal, aceitam edge deployment e retenção explícitos e nunca são excluídos automaticamente. A exportação de um ambiente Axiom espera a ação manual de Correlation e `--correlation-confirmed`.

Consulte estes documentos:

- [Perfis oficiais de observabilidade](docs/profiles.md)
- [Ambientes isolam dados sem acoplar a aplicação](docs/environment-management.md)
- [Configurar um projeto com ambientes remotos](docs/setup-project-environments.md)
- [Referência da CLI](docs/cli-reference.md)
- [Migrar o SDK e a CLI para 0.3](docs/migration-0.3.md)

Com a stack no ar, o canário valida traces, logs e métricas no pipeline completo:

```sh
OBSERVABILITY_E2E=1 bun test:canary
```

### Canário deployed (Axiom)

O alvo `deployed` roda o canário na fronteira de aceitação real. A fronteira é aplicação -> Collector -> Axiom. O teste usa APL para traces e logs. O teste usa MPL para métricas.

Use `production.yaml` com datasets E2E dedicados. Defina estas variáveis:

- `AXIOM_TOKEN`.
- `AXIOM_DATASET_TRACES`.
- `AXIOM_DATASET_LOGS`.
- `AXIOM_DATASET_METRICS`.

```sh
OBSERVABILITY_E2E_DEPLOYED=1 bun test:canary:deployed
```

Na CI, o passo roda somente quando o secret `AXIOM_TOKEN` está configurado, junto com as variables `AXIOM_DATASET_*`. Use datasets E2E dedicados com retenção curta (1 dia); a limpeza dos dados de teste é feita pela retenção. Não aponte o canário para datasets de produção.

O projeto usa [Effect](https://effect.website) v4 e conventional commits.

### Release

Toda preparação e publicação segue o [runbook de publicação independente](docs/release-publication-runbook.md). Cada pacote usa um tag `<slug>@<semver>`, notas e checksum próprios. Não crie tags, releases, assets ou publicações npm fora do gate humano documentado no runbook.

## Propriedade e transferência

Não existe modo de propriedade. As credenciais e os endpoints definem o dono: os recursos vivem na org Axiom, Sentry e Cloudflare que as envs do projeto apontam. Para transferir um projeto, troque as credenciais. O código não muda.

Quando a transferência para o cliente é um cenário previsto, provisione na org do cliente desde o início. A transferência vira revogação de acesso, sem migração de dados.

## Licença

[Apache-2.0](LICENSE)
