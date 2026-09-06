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

OTLP, traces e métricas pertencem ao núcleo. Aplicações registram adapters oficiais de eventos, defeitos e browser ingest com `registerOfficialAdapter`. Registros de teste e suas factories existem somente no entrypoint `@equipe-tech/observability/testing` e são rejeitados pelas factories oficiais.

`react-web` é somente um descritor de contrato nesta entrega. O OBS-54 fornecerá a factory de browser. A factory de Node rejeita `react-web` porque esse perfil não possui runtime global de Node.

## Configuração de Node

`parseNodeObservabilityConfig` analisa valores explícitos. `nodeObservabilityConfigFromEnv` analisa ambiente. As duas entradas permanecem separadas e não aplicam precedência entre fontes.

`createNodeObservability` é a entrada assíncrona para aplicações Node. Ela analisa o ambiente, inicia o runtime e devolve um handle que a aplicação deve fechar. `makeNodeObservability` recebe uma configuração já analisada e devolve um `Effect`, para composição em programas Effect. `layerNodeObservability` fornece `NodeObservabilityService` em uma `Layer` com escopo e fecha o handle uma vez quando o escopo termina.

Um endpoint em `localhost`, `localhost.`, `127.0.0.0/8`, `::1` ou no equivalente IPv4-mapped de `127.0.0.0/8` define escopo local. Somente essa classificação permite que o parser use `0.0.0` e `development`. Um sidecar de produção acessado por loopback deve definir `OTEL_SERVICE_VERSION` e `OTEL_DEPLOYMENT_ENVIRONMENT` explicitamente. Qualquer endpoint não loopback exige as duas variáveis.

`OTEL_SERVICE_VERSION` é a identidade canônica da release. Um valor não vazio em `SENTRY_RELEASE` ou `OTEL_SERVICE_RELEASE` encerra o bootstrap.

O valor literal `production` torna o adapter de defeitos obrigatório para `nestjs-api`, `worker` e `react-web`.

## Ciclo de vida

O runtime inicia adapters na ordem de capacidades declarada pelo perfil. Uma falha fecha os adapters já iniciados na ordem inversa.

O encerramento de Node tem um prazo absoluto de 5000 ms. Esse prazo contém 3950 ms para o trabalho normal de `close`, até 500 ms para a limpeza forçada de adapters que excederam seu prazo, até 500 ms para o descarte do runtime e 50 ms de margem para o scheduler. Cada perfil define a ordem das capacidades. Métricas recebem no máximo 3000 ms dentro dos 3950 ms de trabalho normal. Adapters dentro de uma etapa executam em sequência.

Quando o primeiro `close` de um adapter excede o prazo, o runtime interrompe a execução e faz uma única nova tentativa com o orçamento limitado de limpeza forçada. Por isso, implementações de `ObservabilityAdapterHandle.close` devem tolerar interrupção e ser idempotentes. A segunda chamada deve concluir a mesma limpeza sem depender do ponto em que a primeira foi interrompida.

O descarte do runtime é o último resultado explícito do relatório. Quando não resta orçamento, o resultado é `deadline-exceeded` e o relatório fica degradado. O campo JSON opcional `forcedCleanup` aparece somente no resultado `deadline-exceeded` de um adapter que recebeu a tentativa forçada. A serialização omite o campo nos demais resultados.

Chamadas concorrentes da mesma operação compartilham o relatório. `close` espera um `flush` já iniciado terminar antes de começar. `close` e `dispose` devolvem o mesmo relatório final depois da primeira chamada.

`DataPolicy` declara atributos e bloqueios. A aplicação pode acrescentar regras, mas não remove a base. A aplicação da política aos sinais pertence ao OBS-47.

Identidade, endpoint, ambiente, topologia, rota, proxy, secrets e valores de deploy continuam sob responsabilidade da aplicação.
