# Perfis oficiais de observabilidade

Cada processo seleciona um dos cinco perfis fechados. Combinações livres de flags não formam um perfil válido.

| Perfil       | Eventos     | Traces      | Métricas    | Defeitos                | Browser ingest | Runtime        | Prazo |
| ------------ | ----------- | ----------- | ----------- | ----------------------- | -------------- | -------------- | ----- |
| `nestjs-api` | obrigatório | obrigatório | obrigatório | obrigatório em produção | opcional       | Node global    | 5 s   |
| `worker`     | obrigatório | obrigatório | obrigatório | obrigatório em produção | proibido       | Node global    | 5 s   |
| `react-web`  | obrigatório | obrigatório | opcional    | obrigatório em produção | obrigatório    | browser global | 2 s   |
| `cli`        | obrigatório | opcional    | opcional    | opcional                | proibido       | Node global    | 5 s   |
| `library`    | proibido    | proibido    | proibido    | proibido                | proibido       | nenhum         | 0 s   |

Bibliotecas podem exportar definições de instrumentos. O perfil `library` proíbe somente um runtime global.

OTLP, traces e métricas pertencem ao núcleo. Aplicações registram somente adapters oficiais de eventos, defeitos e browser ingest. Adapters de gravação usam uma marca própria exportada pelo entrypoint `testing`.

## Configuração de Node

`parseNodeObservabilityConfig` analisa valores explícitos. `nodeObservabilityConfigFromEnv` analisa ambiente. As duas entradas permanecem separadas e não aplicam precedência entre fontes.

Um endpoint em `localhost`, `127.0.0.0/8` ou `::1` define escopo local. Somente nesse escopo o parser usa `0.0.0` e `development`. Qualquer outro endpoint exige `OTEL_SERVICE_VERSION` e `OTEL_DEPLOYMENT_ENVIRONMENT`.

`OTEL_SERVICE_VERSION` é a identidade canônica da release. Um valor não vazio em `SENTRY_RELEASE` ou `OTEL_SERVICE_RELEASE` encerra o bootstrap.

O valor literal `production` torna o adapter de defeitos obrigatório para `nestjs-api`, `worker` e `react-web`.

## Ciclo de vida

O runtime inicia adapters em ordem declarada. Uma falha fecha os adapters já iniciados na ordem inversa.

O encerramento de Node tem um prazo absoluto de 5 segundos. A ordem é fechamento de intake, eventos, traces, defeitos, métricas e descarte do runtime. Métricas recebem no máximo 3 segundos e nunca ultrapassam o tempo restante do prazo absoluto. Adapters dentro de uma etapa executam em sequência.

`flush`, `close` e `dispose` compartilham operações concorrentes. `close` e `dispose` devolvem o mesmo relatório final depois da primeira chamada.

`DataPolicy` declara atributos e bloqueios. A aplicação pode acrescentar regras, mas não remove a base. A aplicação da política aos sinais pertence ao OBS-47.

Identidade, endpoint, ambiente, topologia, rota, proxy, secrets e valores de deploy continuam sob responsabilidade da aplicação.
