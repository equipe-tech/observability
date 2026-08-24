# observability

Plataforma de observabilidade da Equipe Tech. Um contrato OpenTelemetry, um Collector por stack e adapters para cada runtime. O mesmo pipeline roda no desenvolvimento local e na produção.

> Status: pipeline local implementado. Pacote de telemetria, CLI e stack local funcionam de ponta a ponta; adapters por runtime e provisionamento vêm em seguida.

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
  telemetry/          @equipe-tech/observability: config validada, layer OTLP (traces, logs, métricas) e wide events sobre Effect
  cli/                observability dev up|down|status: ciclo de vida da stack local
collector/            configurações do OTel Collector (local.yaml, production.yaml)
compose/              stack local (collector 0.159.0 + otel-desktop-viewer v0.4.1)
docs/                 padrões de código, erros, testes e workflow
tools/oxlint/         plugins de lint do projeto (anti-slop, effect)
repos/                repositórios vendorados para agentes (gitignored)
```

Alvos seguintes: adapters por runtime (node, nestjs, browser, testing) e provisionamento de assets no CLI.

## Desenvolvimento

Requisitos: Bun `1.4+` e [Vite+](https://viteplus.dev) `0.3.0`.

```sh
bun install         # instala e habilita os hooks de git
bun repos:sync      # clona os repositórios vendorados em repos/
bun check           # lint (type-aware) + format + type-check
bun test            # testes
```

### Stack local

```sh
bun packages/cli/src/main.ts dev up       # sobe collector + viewer (UI em http://localhost:8000)
bun packages/cli/src/main.ts dev status   # estado da stack
bun packages/cli/src/main.ts dev down     # derruba a stack
```

Com a stack no ar, o canário valida o pipeline completo (app -> collector -> destino):

```sh
OBSERVABILITY_E2E=1 bun test:canary
```

O projeto usa [Effect](https://effect.website) v4 e conventional commits.

## Propriedade e transferência

Não existe modo de propriedade. As credenciais e os endpoints definem o dono: os recursos vivem na org Axiom, Sentry e Cloudflare que as envs do projeto apontam. Para transferir um projeto, troque as credenciais. O código não muda.

Quando a transferência para o cliente é um cenário previsto, provisione na org do cliente desde o início. A transferência vira revogação de acesso, sem migração de dados.

## Licença

[Apache-2.0](LICENSE)
