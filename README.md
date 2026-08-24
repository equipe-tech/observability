# observability

Plataforma de observabilidade da Equipe Tech. Um contrato OpenTelemetry, um Collector por stack e adapters para cada runtime. O mesmo pipeline roda no desenvolvimento local e na produção.

> Status: bootstrap. A estrutura abaixo descreve o alvo do projeto.

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

| Componente | Responsabilidade |
| --- | --- |
| Pacote | Instrumentação, contrato de eventos, contexto e adapters |
| Collector | Redação, batch, retry, roteamento e enriquecimento |
| Axiom | Logs, traces, métricas, dashboards e monitores |
| Sentry | Exceções, releases, source maps e Session Replay |
| Cloudflare | Tunnel, WAF, rate limit e correlação via `CF-Ray` |

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

## Estrutura planejada

```text
packages/
  telemetry/          contrato, redação, contexto, adapters (core, node, nestjs, browser, testing)
  cli/                observability dev|test|kamal|verify e provisionamento de assets
collector/            configurações do OTel Collector por perfil
compose/              stack local (collector + viewer)
docs/                 ADRs, runbooks e guias de adoção
```

## Modelo de propriedade

Todo projeto declara o dono da telemetria desde a primeira versão:

```text
ownership.mode = agency | client
```

- `agency`: Axiom, Sentry e Cloudflare pertencem à Equipe Tech.
- `client`: os recursos pertencem ao cliente. O CLI provisiona com credenciais do cliente.

## Licença

[Apache-2.0](LICENSE)
