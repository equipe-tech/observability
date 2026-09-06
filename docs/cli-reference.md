# Referência da CLI

`observability` gerencia a stack local, os assets do Collector, e os recursos remotos de observabilidade.

## `auth login axiom`

```text
observability auth login axiom --organization-id <id>
```

O comando solicita um personal access token em um prompt protegido. A CLI valida o token com `GET /v2/user`.

A CLI salva o token e o identificador da organização no arquivo local de credenciais.

## `auth login sentry`

```text
observability auth login sentry \
  --organization <slug> \
  --team <slug> \
  [--url https://sentry.io]
```

O comando solicita um organization auth token em um prompt protegido. A CLI valida o acesso à organização informada.

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

Repita `--provider` para selecionar os dois providers. Valores duplicados produzem uma seleção única.

Sem `--provider`, um ambiente novo configura Axiom e Sentry. Um ambiente existente repete os providers salvos.

A seleção é aditiva. Selecionar Axiom em um ambiente Sentry adiciona Axiom sem remover Sentry.

Axiom cria traces e logs como `axiom:events:v1` e métricas como `otel:metrics:v1`. `--axiom-edge-deployment` aplica e verifica um edge deployment explícito. `--axiom-retention-days` aceita somente dias positivos e aplica retenção explícita somente na criação. Se um dataset existente divergir em dias ou `useRetentionPeriod`, o preflight falha sem mutação. A CLI nunca altera retenção nem exclui datasets durante reconciliação.

Axiom não oferece uma API pública estável para grupos de Correlation. Uma primeira invocação concluída salva e imprime uma ação manual com o nome, slug e os três datasets. Depois de criar o grupo no Console, repita o provisionamento com `--correlation-confirmed` e um `--axiom-edge-deployment` explícito. A confirmação rejeita a mesma invocação que cria recursos, exige a ação manual persistida correspondente e verifica o edge exato em traces, logs e métricas.

Sentry usa um projeto para todos os ambientes da aplicação.

`--rotate-token` exige Axiom em todos os ambientes solicitados. A CLI marca a mutação como pendente antes da chamada ao Axiom e salva o novo segredo após cada ambiente. Uma falha de transporte, resposta ilegível, HTTP 5xx ou status 2xx inesperado exige outra rotação explícita.

`--force` afeta somente os assets locais. A flag não sobrescreve recursos remotos.

## `env list`

```text
observability env list [--name <project>]
```

O comando lista os ambientes salvos no arquivo local de credenciais. A lista não confirma que os destinos receberam telemetria.

## `env export`

```text
observability env export \
  --name <project> \
  --environment <name>
```

O comando sempre imprime `OTEL_SERVICE_NAME` e `OTEL_DEPLOYMENT_ENVIRONMENT`.

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
| `OBS_CLI_REMOTE_INVALID_PROJECT`               | O nome do projeto é inválido.                                               |
| `OBS_CLI_REMOTE_INVALID_ENVIRONMENT`           | O ambiente ou o nome derivado de um dataset é inválido.                     |
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
