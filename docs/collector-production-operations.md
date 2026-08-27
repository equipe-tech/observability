# Operar a fila persistente do Collector

O Collector de produção mantém uma fila independente para traces, logs e métricas. Cada fila aceita no máximo 64 requisições. O batching do exporter limita cada requisição exportada a 8 MiB quando o sinal pode ser dividido. O limite lógico aproximado é 512 MiB por sinal, sem contar o overhead do bbolt.

O retry não expira. Capacidade de fila e capacidade do filesystem limitam o uso de recursos. Erros permanentes do destino, incluindo credenciais inválidas, podem descartar telemetria. Nunca exponha uma fila não vazia a uma credencial que ainda não foi verificada.

## Preparar o host

O asset provisionado usa `/var/lib/observability/<name>/collector/queue`. Antes do primeiro boot:

1. Monte um filesystem dedicado de 8 GiB em `/var/lib/observability/<name>/collector`.
2. Confirme que o path é um mount separado.
3. Confirme capacidade total de 8 GiB e pelo menos 2 GiB livres.
4. Confirme owner `10001:10001` e mode `0700` no diretório `queue`.
5. Interrompa o deploy se qualquer precondição falhar.

O Kamal prepara o diretório com owner e mode declarados no accessory. O filesystem dedicado continua sendo uma precondição de infraestrutura. Não substitua esse diretório por um named volume root-owned.

Execute o preflight no host e não prossiga se um teste falhar:

```sh
QUEUE_ROOT="/var/lib/observability/<name>/collector"
test "$(findmnt --noheadings --output TARGET --target "$QUEUE_ROOT")" = "$QUEUE_ROOT"
test "$(find "$QUEUE_ROOT/queue" -maxdepth 0 -printf '%U:%G %m')" = "10001:10001 700"
test "$(df --block-size=1 --output=size "$QUEUE_ROOT" | tail -1 | tr -d ' ')" -ge "8589934592"
test "$(df --block-size=1 --output=avail "$QUEUE_ROOT" | tail -1 | tr -d ' ')" -ge "2147483648"
```

Cada banco do `file_storage` tem limite terminal de 2 GiB. Os três bancos podem ocupar até 6 GiB. `max_size` é somente um último limite de proteção. A saturação física pode ocorrer sem incremento confiável nos contadores de rejeição. Não espere um banco chegar a 2 GiB.

## Saúde, métricas e alertas

O accessory publica somente em loopback:

- `http://127.0.0.1:13133/health` para saúde do processo.
- `http://127.0.0.1:8888/metrics` para telemetria interna.

Use timeout de 5 segundos no probe externo e alerte depois de três falhas consecutivas:

```sh
curl --max-time 5 --fail --silent --show-error http://127.0.0.1:13133/health
```

HTTP 200 informa que o processo e os componentes configurados iniciaram. Uma indisponibilidade do destino ou uma fila saturada permanece saudável enquanto o Collector continua executando. Falha de conexão indica startup, restart, shutdown, falha do processo ou falha de bind. O asset não declara Docker health porque a imagem distroless não contém uma ferramenta interna de probe.

Consulte estes contadores e gauges em `0.159.0`:

- Entrada aceita: `otelcol_receiver_accepted_spans`, `otelcol_receiver_accepted_log_records`, `otelcol_receiver_accepted_metric_points`.
- Entrada recusada: `otelcol_receiver_refused_spans`, `otelcol_receiver_refused_log_records`, `otelcol_receiver_refused_metric_points`.
- Estado da fila: `otelcol_exporter_queue_size`, `otelcol_exporter_queue_capacity`, `otelcol_exporter_in_flight_requests`.
- Falha de enqueue: `otelcol_exporter_enqueue_failed_spans`, `otelcol_exporter_enqueue_failed_log_records`, `otelcol_exporter_enqueue_failed_metric_points`.
- Falha de envio: `otelcol_exporter_send_failed_spans`, `otelcol_exporter_send_failed_log_records`, `otelcol_exporter_send_failed_metric_points`.
- Envio concluído: `otelcol_exporter_sent_spans`, `otelcol_exporter_sent_log_records`, `otelcol_exporter_sent_metric_points`.
- Tamanho do batch: `otelcol_exporter_enqueue_size_bytes`, `otelcol_exporter_queue_batch_send_size_bytes`.

A versão `0.159.0` não expõe um contador estável dedicado a retry. Falhas de envio crescentes junto com fila persistente indicam retry. Essas métricas detalhadas de exporter têm estabilidade alpha.

Use estes thresholds por exporter:

| Estado    |                                  Fila |    Duração |
| --------- | ------------------------------------: | ---------: |
| Warning   |           pelo menos 45 de 64, ou 70% | 15 minutos |
| Critical  |           pelo menos 55 de 64, ou 85% |  5 minutos |
| Emergency |           pelo menos 61 de 64, ou 95% |   1 minuto |
| Saturated | 64 de 64 ou qualquer falha de enqueue |   imediato |

No filesystem dedicado:

- Warning em 60% usados, ou 4,8 GiB.
- Critical em 70% usados, ou 5,6 GiB.
- Hard stop em 75% usados, ou 6 GiB.
- Hard stop com menos de 2 GiB livres.

No hard stop, interrompa os produtores de telemetria e preserve a fila. Não apague arquivos para recuperar capacidade.

## Inspecionar e drenar

Para inspecionar:

1. Verifique o health endpoint.
2. Capture todas as métricas de fila, enqueue e envio.
3. Registre o container ID e o digest da imagem.
4. Registre capacidade e espaço livre do filesystem.
5. Registre o tamanho de cada banco.
6. Mantenha o Collector ativo.

Não abra um banco bbolt vivo com outro writer. Não copie arquivos bbolt vivos como backup.

Para drenar:

1. Interrompa os produtores de telemetria.
2. Mantenha o Collector ativo.
3. Verifique que o destino aceita telemetria.
4. Aguarde cada `otelcol_exporter_queue_size` chegar a zero.
5. Aguarde 30 segundos e confirme zero novamente.
6. Confirme que os contadores de envio cresceram.
7. Confirme que os contadores de enqueue failure não cresceram.
8. Faça backup frio antes de qualquer manutenção.

## Backup frio

1. Interrompa os produtores.
2. Aguarde o fim de entrada em voo.
3. Pare o accessory.
4. Confirme que nenhum container usa o diretório.
5. Crie um archive fora do filesystem dedicado, preservando owners numéricos.
6. Gere e registre o SHA-256.
7. Registre source path, image digest e timestamp.
8. Reinicie com a mesma configuração.
9. Verifique saúde e métricas de fila.

```sh
sudo tar --numeric-owner -C "$QUEUE_ROOT" -czf "$BACKUP_PATH" queue
sha256sum "$BACKUP_PATH" > "$BACKUP_PATH.sha256"
```

## Rotacionar token

1. Mantenha o token antigo ativo.
2. Crie o token novo.
3. Verifique o token novo fora da fila de produção.
4. Interrompa os produtores.
5. Drene com o token antigo.
6. Confirme fila zero duas vezes.
7. Faça backup frio.
8. Instale o novo secret do Kamal.
9. Reinicie o accessory com o mesmo diretório.
10. Envie um canário único para cada sinal.
11. Confirme export bem-sucedido e fila zero.
12. Revogue o token antigo.

Se a verificação do token novo falhar, restaure o secret antigo. Não reinicie uma fila não vazia com credenciais não verificadas.

## Quarentena e rollback

Quarentena é uma operação destrutiva do ponto de vista da fila ativa. Exige aprovação explícita de perda de dados. Nunca é automática.

1. Confirme que recuperação do destino e rollback de token falharam.
2. Obtenha aprovação explícita de perda de dados.
3. Interrompa produtores e Collector.
4. Faça e assine um backup frio.
5. Renomeie `queue` para um diretório irmão com timestamp.
6. Crie um novo `queue` com mode `0700` e owner `10001:10001`.
7. Inicie o Collector e verifique saúde.
8. Envie um canário único por sinal e verifique export.
9. Retenha a quarentena até o fim da janela de rollback.

Nunca apague a quarentena durante a recuperação.

Para rollback, interrompa produtores e Collector, mova a fila nova para outro path de quarentena, restaure o nome original, confira owner e mode, restaure o token antigo quando necessário, reinicie e só então retome produtores depois de verificar saúde e profundidade da fila.

## Garantias e limites

A fila oferece entrega pelo menos uma vez. Uma falha abrupta pode duplicar dados. Payload comprimido pode expandir na memória. O bbolt retém a alocação máxima depois do drain. Erros permanentes do destino podem descartar itens. A garantia de 8 GiB depende do filesystem provisionado no host e não pode ser criada somente pelo asset do Kamal.
