# observability

Plataforma de observabilidade da Equipe Tech. Um contrato OpenTelemetry, um Collector por stack e adapters para cada runtime. O mesmo pipeline roda no desenvolvimento local e na produção.

> Status: pipeline local, adapters por runtime e provisionamento implementados. Pacote de telemetria, adapters (node, nestjs, browser, testing), CLI, stack local e provisionamento dos assets de produção funcionam de ponta a ponta.

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

O Collector roda como accessory do [Kamal](https://kamal-deploy.org), com fila persistente e sem porta OTLP pública.

## Estrutura

```text
packages/
  telemetry/          @equipe-tech/observability: config validada, layer OTLP (traces, logs, métricas), wide events e adapters sobre Effect
  cli/                observability dev|provision: CLI, assets da stack local e do Collector de produção
docs/                 padrões de código, erros, testes e workflow
tools/oxlint/         plugins de lint do projeto (anti-slop, effect)
repos/                repositórios vendorados para agentes (gitignored)
```

### Adapters

O pacote `@equipe-tech/observability` publica um subpath por runtime:

| Subpath     | Conteúdo                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `./node`    | `runMain` (telemetria do ambiente, interrupção em `SIGINT`/`SIGTERM`, flush no shutdown) e ingestão de eventos do browser    |
| `./nestjs`  | `TelemetryInterceptor` (spans de fronteira HTTP), `withRequestSpan` e `createBrowserEventsController` (`/_telemetry/events`) |
| `./browser` | `BrowserTelemetry` (fila limitada, batch e flush de wide events para `/_telemetry/events`) com transporte `fetch` injetável  |
| `./testing` | Captura em memória dos exports OTLP reais (`run`, `makeCapture`) para asserts de spans, logs e métricas em testes            |

O contrato do endpoint `/_telemetry/events` vive em `BrowserEvents` no entrypoint raiz. O servidor faz o parse com `parseBrowserEventBatch` e re-emite os eventos como wide events com atributos de servidor (`event.source`, `browser.event.id`).

O adapter `./nestjs` publica o endpoint pronto: registre `createBrowserEventsController(runtime)` nos controllers do módulo. O controller responde `202 { accepted }` e rejeita batches inválidos com `400 { code, message, correlationId }`, onde `correlationId` é o `trace_id` do span da requisição. O limite de corpo bruto pertence ao transporte HTTP; o Express responde `413` acima do limite configurado.

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

O comando é idempotente. Um arquivo provisionado que foi modificado localmente gera o erro `OBS_CLI_PROVISION_CONFLICT`; use `--force` para sobrescrever. Depois do merge do accessory, defina o secret `AXIOM_TOKEN` no Kamal.

Com a stack no ar, o canário valida traces, logs e métricas no pipeline completo:

```sh
OBSERVABILITY_E2E=1 bun test:canary
```

### Canário deployed (Axiom)

O alvo `deployed` roda o mesmo canário contra a fronteira de aceitação real: aplicação -> Collector com a configuração de produção -> Axiom -> consulta APL. Requisitos: um Collector local com `production.yaml` apontado para datasets E2E dedicados e as variáveis `AXIOM_TOKEN`, `AXIOM_DATASET_TRACES` e `AXIOM_DATASET_LOGS`.

```sh
OBSERVABILITY_E2E_DEPLOYED=1 bun test:canary:deployed
```

Na CI, o passo roda somente quando o secret `AXIOM_TOKEN` está configurado, junto com as variables `AXIOM_DATASET_*`. Use datasets E2E dedicados com retenção curta (1 dia); a limpeza dos dados de teste é feita pela retenção. Não aponte o canário para datasets de produção.

O projeto usa [Effect](https://effect.website) v4 e conventional commits.

### Release

```sh
bun scripts/release.ts patch          # ou minor, major, x.y.z, x.y.z-rc.1
git push origin master --follow-tags
```

O script alinha as versões dos dois pacotes, cria o commit `chore: release vX.Y.Z` e a tag anotada. O push da tag dispara o workflow `release`:

1. `tag-check` valida o formato da tag e a igualdade com os manifests.
2. `verify` roda o CI completo, incluindo o canário local e, com secrets, o deployed.
3. `release` empacota os tarballs, gera as notas a partir dos conventional commits e cria o GitHub Release com os assets.
4. `publish-npm` baixa os tarballs do release e publica no npm com o dist-tag correto (`latest`, ou `alpha`/`beta`/`rc` para pré-releases). Sem o secret `NPM_TOKEN`, o passo é pulado com aviso.

O workflow `release-preflight` (manual) valida a configuração antes de criar a tag: versões alinhadas, notas, empacotamento e credenciais npm.

## Propriedade e transferência

Não existe modo de propriedade. As credenciais e os endpoints definem o dono: os recursos vivem na org Axiom, Sentry e Cloudflare que as envs do projeto apontam. Para transferir um projeto, troque as credenciais. O código não muda.

Quando a transferência para o cliente é um cenário previsto, provisione na org do cliente desde o início. A transferência vira revogação de acesso, sem migração de dados.

## Licença

[Apache-2.0](LICENSE)
