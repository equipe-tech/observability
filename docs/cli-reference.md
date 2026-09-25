# Referência da CLI

`observability` gerencia a stack local, os assets do Collector, e os recursos remotos de observabilidade.

## `auth login axiom`

```text
observability auth login axiom --organization-id <id> [--token-env <name>]
```

Sem `--token-env`, o comando solicita um personal access token em um prompt protegido. Com a flag, a CLI lê a variável nomeada e falha antes do provider quando o valor está ausente, vazio ou inválido. A CLI valida o token com `GET /v2/user`.

A CLI salva o token e o identificador da organização no arquivo local de credenciais.

## `auth login sentry`

```text
observability auth login sentry \
  --organization <slug> \
  --team <slug> \
  [--url https://sentry.io] \
  [--token-env <name>]
```

Sem `--token-env`, o comando solicita um organization auth token em um prompt protegido. Com a flag, a CLI aplica a mesma validação de variável do login Axiom. A CLI valida o acesso à organização informada.

`--url` permite um servidor Sentry próprio. O valor padrão é `https://sentry.io`.

## `auth status`

```text
observability auth status
```

O comando valida cada credencial salva contra o provider. A saída também contém o caminho do arquivo de credenciais.

## `provision`

```text
observability provision \
  [--dir <path>] \
  [--name <project>] \
  [--queue-mode <best-effort|durable>] \
  [--force] \
  [--environment <name>]... \
  [--provider <axiom|sentry>]... \
  [--sentry-platform <platform>] \
  [--rotate-token] \
  [--axiom-edge-deployment <id>] \
  [--axiom-retention-days <days>] \
  [--correlation-confirmed]
```

Sem `--environment`, o comando gera somente os assets locais. As flags remotas válidas não fazem chamadas externas nesse modo.

`--queue-mode` seleciona o armazenamento da fila do Collector. O valor padrão é `durable`. O modo `durable` usa `file_storage`, um diretório persistente no accessory e retry sem limite. O modo `best-effort` mantém até 64 requisições por sinal na memória e limita o retry a cinco minutos. Um restart perde o backlog do modo `best-effort`.

A CLI grava a seleção em `observability/provision.json`. Repetir o mesmo comando mantém os três arquivos inalterados. Para trocar o modo, passe `--force`. Sem a flag, a CLI retorna `OBS_CLI_PROVISION_CONFLICT` antes de escrever qualquer arquivo. Um valor desconhecido retorna `OBS_CLI_PROVISION_INVALID_QUEUE_MODE` antes de criar o diretório `observability`.

Repita `--provider` para selecionar os dois providers. Valores duplicados produzem uma seleção única.

Sem `--provider`, um ambiente novo configura Axiom e Sentry. Um ambiente existente repete os providers salvos.

A seleção é aditiva. Selecionar Axiom em um ambiente Sentry adiciona Axiom sem remover Sentry.

Axiom cria traces e logs como `axiom:events:v1` e métricas como `otel:metrics:v1`. `--axiom-edge-deployment` aplica e verifica um edge deployment explícito. `--axiom-retention-days` aceita somente dias positivos e aplica retenção explícita somente na criação. Se um dataset existente divergir em dias ou `useRetentionPeriod`, o preflight falha sem mutação. A CLI nunca altera retenção nem exclui datasets durante reconciliação.

Axiom não oferece uma API pública estável para grupos de Correlation. Uma primeira invocação concluída salva e imprime uma ação manual com o nome, slug e os três datasets. Depois de criar o grupo no Console, repita o provisionamento com `--correlation-confirmed` e um `--axiom-edge-deployment` explícito. A confirmação rejeita a mesma invocação que cria recursos, exige a ação manual persistida correspondente e verifica o edge exato em traces, logs e métricas.

Sentry usa um projeto para todos os ambientes da aplicação.

`--rotate-token` exige Axiom em todos os ambientes solicitados. A CLI marca a mutação como pendente antes da chamada ao Axiom e salva o novo segredo após cada ambiente. Uma falha de transporte, resposta ilegível, HTTP 5xx ou status 2xx inesperado exige outra rotação explícita.

`--force` afeta somente os assets locais. A flag não sobrescreve recursos remotos.

## `ops plan`, `ops apply` e `ops verify`

```text
observability ops plan [--dir <path>] [--environment <name>]... --axiom-edge-deployment <edge> [--queue-mode <durable|best-effort>] [--accept-best-effort-data-loss] [--json]
observability ops apply [--dir <path>] [--environment <name>]... --axiom-edge-deployment <edge> --plan <file> [--queue-mode <durable|best-effort>] [--accept-best-effort-data-loss] [--allow-destructive] [--confirm-manual <id>]... [--json]
observability ops verify [--dir <path>] [--environment <name>]... --axiom-edge-deployment <edge> [--json]
```

`plan` decodifica `observability/operations.yaml`, `observability/contract.json` e todas as queries antes de carregar credenciais. O manifesto rejeita diretivas YAML, tags, anchors, aliases e merge keys. O comando faz somente leituras remotas e grava `.observability/plan-<sha256>.json` com modo `0600`.

`apply` exige esse arquivo exato. A CLI recalcula as precondições e rejeita manifesto, contrato, credenciais ou provider alterado. O plano inclui datasets, edge deployment Axiom obrigatório, token de ingestão, projeto e client key Sentry, modo da fila e fingerprint e caminhos dos assets locais do Collector. O apply rejeita mudanças locais posteriores ao plan; verify reporta drift local. O padrão é `durable`; `best-effort` exige `--accept-best-effort-data-loss` em plan e apply. `--allow-destructive` vale somente para o digest fornecido. `--confirm-manual` registra confirmação do operador somente para um ID contido no mesmo plano. Cada mutação grava intenção antes da chamada e executa read-back limitado. Após uma interrupção ou resposta ambígua, a próxima execução lê o dataset. O estado desejado conclui a intenção e a ausência permite repetir a criação idempotente.

Dashboards e monitores declarados no manifesto viram criações e atualizações planejadas. O plano contém somente IDs, nomes de recurso e fingerprints. Queries, IDs de notifier e respostas do provider ficam fora do plano. Um dashboard existente sem o marcador gerenciado no uid desejado faz o plano falhar, e a CLI não o adota. A CLI nunca apaga dashboards ou monitores.

`verify` faz somente leituras. Drift, mutação sem resultado conhecido e ação manual pendente causam falha. Consulte [Manifesto de operações](operations-manifest.md) para o schema, a gramática de queries e a tabela de capacidades.

As queries gerenciadas têm estes limites:

- 16384 caracteres no texto de entrada e no texto compilado;
- 64 estágios, 64 comparações por estágio `where` e 64 campos de agrupamento por estágio `summarize`;
- 256 valores por predicado `in`, binding ou destino, e 512 valores de predicado no total;
- 1024 nós na AST e 4096 bytes UTF-8 cumulativos em literais;
- 128 caracteres por campo e 32 caracteres por token de quantil ou duração;
- 255 bytes UTF-8 no nome do dataset e 128 bytes UTF-8 por nome de sinal.

## `deploy plan`, `deploy apply` e `env github`

```text
observability deploy plan \
  --dir <path> \
  --repo <owner/name> \
  --name <project> \
  --environment <environment> \
  --release <immutable-version> \
  [--rollout <disabled|enabled>]
observability deploy apply --plan <path> [--approve-rollout]
```

`deploy plan` e `deploy apply` permanecem aliases de compatibilidade somente para a integração com GitHub. `env github plan` e `env github apply` são os nomes explícitos. O ambiente remoto já deve ter sido provisionado pela CLI, o grupo Axiom Correlation deve ter confirmação manual e o GitHub Environment deve existir com suas proteções configuradas. O comando nunca cria ou altera proteções, faz deploy da aplicação ou concede aprovação de rollout.

`plan` consulta somente metadados do GitHub, grava `.observability/github-plan-<sha256>.json` com modo `0600` e lista cada criação ou sobrescrita. O plano contém variáveis não secretas, nomes de secrets, efeitos e fingerprints de metadados. Nunca contém tokens ou DSNs. O plano usa `AXIOM_TOKEN`, o nome customizado de DSN e uma allowlist de variáveis de runtime que inclui o nome customizado de release descoberto em `observability/setup.json`. Credenciais administrativas dos providers não são copiadas.

`apply` recalcula o estado e rejeita plano alterado ou stale. O plano exige reviewers, prevenção de self-review e política de branches; IDs e valores dessas proteções entram no digest. Leituras de variables e secrets são paginadas. Secrets são enviados para `gh secret set` pela entrada padrão, nunca por argumento. Depois das escritas, a CLI verifica valores exatos das variables e presença dos metadados dos secrets, sem afirmar igualdade secreta. Cada mutação grava estado `pending`, `completed` ou `outcome-unknown` em arquivo `0600`, e um lock por repositório e ambiente impede apply local concorrente. Uma resposta perdida exige reconciliação ou repetição idempotente da mesma sobrescrita. `--rollout enabled` exige `--approve-rollout` no apply do digest exato. O padrão é `disabled`.

O fluxo completo é deliberadamente sequencial porque o secret do token de ingestão só existe depois do apply de providers: `ops plan`, `ops apply`, confirmação manual de Correlation, `ops verify`, `env github plan` e `env github apply`. O alias `deploy` não provisiona providers. A sincronização GitHub reutiliza o estado seguro salvo por `RemoteEnvironment`; não lê nem analisa a saída insegura de `env export`.

## `env list`

```text
observability env list [--name <project>]
```

O comando lista os ambientes salvos no arquivo local de credenciais. A lista não confirma que os destinos receberam telemetria.

## `env export`

```text
observability env export \
  --name <project> \
  --environment <name> \
  --release <version>
```

O comando sempre imprime `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION` e `OTEL_DEPLOYMENT_ENVIRONMENT`. `--release` aceita SemVer 2.0.0 ou um identificador hexadecimal minúsculo de 7 a 64 caracteres. Um valor inválido retorna `OBS_CLI_REMOTE_INVALID_RELEASE`.

Um ambiente Axiom também imprime:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `AXIOM_TOKEN`
- `AXIOM_DATASET_TRACES`
- `AXIOM_DATASET_LOGS`
- `AXIOM_DATASET_METRICS`

Um ambiente Sentry imprime `SENTRY_DSN`.

Um ambiente combinado imprime a união dessas variáveis. A saída contém segredos e não aplica mascaramento.

Ambientes Axiom bloqueiam a exportação com `OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED` enquanto a ação manual não tiver confirmação explícita.

## Arquivo de credenciais

O caminho padrão é `~/.local/state/observability/credentials.json`. `OBSERVABILITY_HOME` altera o diretório pai.

A CLI cria o diretório com modo `0700`. A CLI cria o arquivo com modo `0600`.

O arquivo contém tokens administrativos, tokens de ingestão, DSNs e o estado dos ambientes. A CLI recusa um arquivo acessível por outros usuários.

A CLI atual migra os formatos 1 e 2 diretamente para a versão 3 antes de uma chamada externa. A migração preserva segredos, IDs, nomes de datasets, estado Sentry, mutações pendentes e o modo `0600`. Ambientes Axiom migrados ficam em `verification-required`.

Não volte para a CLI 0.2.0 após a migração. Ela não lê o formato 3. Restaure um backup seguro do formato anterior somente se também restaurar e validar os segredos de runtime correspondentes.

A CLI serializa atualizações com um lock entre processos. Um comando espera no máximo 30 segundos por outra atualização.

Estado de reconciliação sem segredos fica em `$OBSERVABILITY_HOME/operations/<service>.json`. O arquivo usa escrita atômica, lock exclusivo, geração monotônica e modo `0600`. Esse estado pertence a uma única máquina. Não compartilhe `OBSERVABILITY_HOME` entre máquinas, pois os leases de heartbeat não suportam esse uso. Planos e estado não armazenam queries, tokens, DSNs ou corpos de resposta.

## Convenção de nomes

O nome de um dataset segue este formato:

```text
<project>-<environment>-<signal>
```

`<signal>` aceita `traces`, `logs`, ou `metrics`.

O nome do token Axiom segue este formato:

```text
<project>-<environment>-collector
```

## Erros remotos

| Código                                         | Significado                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `OBS_CLI_PROVISION_INVALID_QUEUE_MODE`         | `--queue-mode` não contém `best-effort` ou `durable`.                       |
| `OBS_CLI_PROVISION_ASSET_INCOMPATIBLE`         | Os assets do pacote não contêm os marcadores esperados pelo renderer.       |
| `OBS_CLI_CREDENTIALS_INVALID`                  | O arquivo ou a configuração de credenciais não passa no parse.              |
| `OBS_CLI_CREDENTIALS_INSECURE`                 | O arquivo de credenciais permite acesso para outros usuários.               |
| `OBS_CLI_CREDENTIALS_FAILED`                   | A CLI não consegue acessar o arquivo de credenciais.                        |
| `OBS_CLI_CREDENTIALS_VERSION_UNSUPPORTED`      | Uma CLI antiga não lê a versão do arquivo.                                  |
| `OBS_CLI_CREDENTIALS_BUSY`                     | Outro processo mantém o lock de atualização.                                |
| `OBS_CLI_REMOTE_CREDENTIALS_MISSING`           | Uma seleção combinada não encontra as duas credenciais.                     |
| `OBS_CLI_REMOTE_PROVIDER_CREDENTIALS_MISSING`  | Um provider selecionado não tem credenciais.                                |
| `OBS_CLI_REMOTE_INVALID_PROVIDER`              | `--provider` não contém `axiom` ou `sentry`.                                |
| `OBS_CLI_REMOTE_UNAUTHORIZED`                  | O provider recusa a credencial ou o acesso à organização.                   |
| `OBS_CLI_REMOTE_FAILED`                        | A requisição falha ou o provider retorna um status inesperado.              |
| `OBS_CLI_REMOTE_INVALID_RESPONSE`              | A resposta do provider não passa no parse.                                  |
| `OBS_CLI_REMOTE_REDIRECTED`                    | O provider responde com redirect 3xx, que a CLI não segue.                  |
| `OBS_CLI_GITHUB_INPUT_INVALID`                 | Repositório, ambiente, release, rollout ou ambiente local é inválido.       |
| `OBS_CLI_GITHUB_ENVIRONMENT_NOT_FOUND`         | O GitHub Environment explícito não existe ou não está acessível.            |
| `OBS_CLI_GITHUB_RESPONSE_INVALID`              | A resposta de metadados do GitHub não passa no schema.                      |
| `OBS_CLI_GITHUB_COMMAND_FAILED`                | `gh` não iniciou, não autenticou ou recusou a operação.                     |
| `OBS_CLI_GITHUB_PLAN_INVALID`                  | O arquivo não passa no schema ou no digest do plano.                        |
| `OBS_CLI_GITHUB_PLAN_STALE`                    | Metadados do GitHub ou configuração local mudaram desde o plano.            |
| `OBS_CLI_GITHUB_ROLLOUT_APPROVAL_REQUIRED`     | Habilitar telemetria requer aprovação explícita do digest exato.            |
| `OBS_CLI_GITHUB_APPLY_OUTCOME_UNKNOWN`         | A resposta da mutação foi perdida e seu resultado não pode ser afirmado.    |
| `OBS_CLI_GITHUB_STATE_FAILED`                  | Plano ou estado de recuperação não pôde ser persistido com segurança.       |
| `OBS_CLI_REMOTE_INVALID_PROJECT`               | O nome do projeto é inválido.                                               |
| `OBS_CLI_REMOTE_INVALID_ENVIRONMENT`           | O ambiente ou o nome derivado de um dataset é inválido.                     |
| `OBS_CLI_REMOTE_INVALID_RELEASE`               | A release não segue a gramática canônica de `service.version`.              |
| `OBS_CLI_REMOTE_ROTATION_NOT_SELECTED`         | Uma rotação inclui um ambiente sem Axiom.                                   |
| `OBS_CLI_REMOTE_TOKEN_UNAVAILABLE`             | O token existe no Axiom, mas a CLI não possui o valor secreto.              |
| `OBS_CLI_REMOTE_PARTIAL_FAILURE`               | Um ambiente falha após a CLI salvar ambientes anteriores.                   |
| `OBS_CLI_REMOTE_OUTCOME_UNKNOWN`               | Uma mutação do token Axiom não tem resultado local confirmado.              |
| `OBS_CLI_REMOTE_ENVIRONMENT_NOT_FOUND`         | O arquivo local não contém o projeto e o ambiente solicitados.              |
| `OBS_CLI_AXIOM_METRICS_MIGRATION_REQUIRED`     | O dataset de métricas existe com kind incompatível e exige migração manual. |
| `OBS_CLI_AXIOM_DATASET_CONFIGURATION_CONFLICT` | Kind, edge deployment ou retenção não corresponde ao contrato solicitado.   |
| `OBS_CLI_AXIOM_REMOTE_NAME_CONFLICT`           | Há nomes remotos duplicados de dataset ou token.                            |
| `OBS_CLI_AXIOM_TOKEN_CAPABILITIES_MISMATCH`    | O token não tem somente ingest-create nos três datasets exatos.             |
| `OBS_CLI_AXIOM_RETENTION_INVALID`              | A retenção informada não é um inteiro positivo.                             |
| `OBS_CLI_CORRELATION_CONFIRMATION_REQUIRED`    | A ação manual de Correlation ainda não foi confirmada.                      |
| `OBS_CLI_MANIFEST_INVALID`                     | O manifesto não passa no schema ou nas regras semânticas.                   |
| `OBS_CLI_CONTRACT_INDEX_STALE`                 | Serviço ou versão do contrato diverge do manifesto.                         |
| `OBS_CLI_SOURCE_INVALID`                       | A fonte declarada diverge do predicado estruturado da query.                |
| `OBS_CLI_PLAN_STALE`                           | Manifesto, contrato ou estado remoto mudou após o plano.                    |
| `OBS_CLI_PLAN_DESTRUCTIVE`                     | O digest contém mudança destrutiva sem autorização exata.                   |
| `OBS_CLI_READ_BACK_TIMEOUT`                    | A leitura limitada não convergiu para o estado desejado.                    |
| `OBS_CLI_MANUAL_ACTION_PENDING`                | Uma ação manual ainda requer confirmação do operador.                       |
| `OBS_CLI_APPLY_OUTCOME_UNKNOWN`                | O resultado atual é ambíguo e será reconciliado na próxima execução.        |
| `OBS_CLI_MUTATION_UNRESOLVED`                  | Uma mutação selecionada continua pendente ou com resultado desconhecido.    |
| `OBS_CLI_MANIFEST_NOT_FOUND`                   | O manifesto de operações não existe.                                        |
| `OBS_CLI_MANIFEST_UNREADABLE`                  | O manifesto de operações não pode ser lido.                                 |
| `OBS_CLI_MANIFEST_VERSION_UNSUPPORTED`         | A versão do manifesto não é suportada.                                      |
| `OBS_CLI_CONTRACT_INDEX_NOT_FOUND`             | O índice de contrato não existe.                                            |
| `OBS_CLI_CONTRACT_INDEX_INVALID`               | O índice de contrato não passa no parse.                                    |
| `OBS_CLI_PLAN_REQUIRED`                        | `apply` não recebeu um plano legível.                                       |
| `OBS_CLI_PLAN_INVALID`                         | O plano, digest, ambiente ou confirmação é inválido.                        |
| `OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE`      | Falta credencial ou projeto Sentry declarado para observar o provider.      |
| `OBS_CLI_DRIFT_DETECTED`                       | O estado observado diverge do manifesto.                                    |
| `OBS_CLI_QUERY_INVALID`                        | A query gerenciada não passa na gramática limitada.                         |
| `OBS_CLI_QUERY_SIGNAL_UNBOUND`                 | A query não vincula o nome do sinal.                                        |
| `OBS_CLI_QUERY_SIGNAL_AMBIGUOUS`               | A query vincula o sinal de forma ambígua.                                   |
| `OBS_CLI_QUERY_SIGNAL_MISMATCH`                | O predicado diverge exatamente das fontes e aliases declarados.             |
| `OBS_CLI_OPERATIONS_STATE_INVALID`             | O estado de operações não passa no parse.                                   |
| `OBS_CLI_OPERATIONS_STATE_FAILED`              | O arquivo de estado não pode ser acessado.                                  |
| `OBS_CLI_OPERATIONS_STATE_BUSY`                | O lock está ocupado ou a geração esperada mudou.                            |
| `OBS_CLI_AXIOM_DATASET_CONFLICT`               | O dataset observado diverge da criação solicitada.                          |
| `OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN`        | O resultado da criação do dataset não pôde ser provado.                     |
| `OBS_CLI_AXIOM_RESOURCE_CONFLICT`              | O dashboard ou monitor mudou no Axiom durante o apply.                      |
| `OBS_CLI_NOTIFIER_UNRESOLVED`                  | A variável do notifier de um monitor está ausente ou inválida.              |
| `OBS_CLI_PROVIDER_RESOURCE_AMBIGUOUS`          | Mais de um monitor no Axiom usa o mesmo marcador gerenciado.                |
| `OBS_CLI_PROVIDER_RESOURCE_UNMANAGED`          | Um dashboard sem marcador gerenciado ocupa o uid desejado.                  |
| `OBS_CLI_DASHBOARD_FILTER_UNSUPPORTED`         | O dashboard declara filtros que a API de dashboards não representa.         |
