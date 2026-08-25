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
  [--sentry-platform <platform>] \
  [--rotate-token]
```

Sem `--environment`, o comando gera somente os assets locais. Esse comportamento mantém compatibilidade com versões anteriores.

Cada `--environment` cria três datasets Axiom e um token de ingestão. Todos os ambientes usam o mesmo projeto Sentry.

`--rotate-token` regenera um token Axiom existente. A CLI salva o novo valor no arquivo local de credenciais.

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

O comando imprime estas variáveis no formato dotenv:

- `OTEL_SERVICE_NAME`
- `OTEL_DEPLOYMENT_ENVIRONMENT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `AXIOM_TOKEN`
- `AXIOM_DATASET_TRACES`
- `AXIOM_DATASET_LOGS`
- `AXIOM_DATASET_METRICS`
- `SENTRY_DSN`

A saída contém segredos. A CLI não mascara a saída desse comando.

## Arquivo de credenciais

O caminho padrão é `~/.local/state/observability/credentials.json`. `OBSERVABILITY_HOME` altera o diretório pai.

A CLI cria o diretório com modo `0700`. A CLI cria o arquivo com modo `0600`.

O arquivo contém tokens administrativos, tokens de ingestão, DSNs, e o estado dos ambientes. A CLI recusa um arquivo acessível por grupo ou outros usuários.

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

| Código                                 | Significado                                                            |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `OBS_CLI_CREDENTIALS_INVALID`          | O arquivo ou a configuração de credenciais não passa no parse.         |
| `OBS_CLI_CREDENTIALS_INSECURE`         | O arquivo de credenciais permite acesso para grupo ou outros usuários. |
| `OBS_CLI_CREDENTIALS_FAILED`           | A CLI não consegue acessar o arquivo de credenciais.                   |
| `OBS_CLI_REMOTE_CREDENTIALS_MISSING`   | O provisionamento remoto não encontra as duas credenciais.             |
| `OBS_CLI_REMOTE_UNAUTHORIZED`          | O provider recusa a credencial ou o acesso à organização.              |
| `OBS_CLI_REMOTE_FAILED`                | A requisição falha ou o provider retorna um status inesperado.         |
| `OBS_CLI_REMOTE_INVALID_RESPONSE`      | A resposta do provider não passa no parse.                             |
| `OBS_CLI_REMOTE_INVALID_ENVIRONMENT`   | O ambiente ou o nome derivado de um dataset é inválido.                |
| `OBS_CLI_REMOTE_TOKEN_UNAVAILABLE`     | O token existe no Axiom, mas a CLI não possui o valor secreto.         |
| `OBS_CLI_REMOTE_ENVIRONMENT_NOT_FOUND` | O arquivo local não contém o projeto e o ambiente solicitados.         |
