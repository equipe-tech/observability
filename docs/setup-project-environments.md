# Configurar um projeto com ambientes remotos

Use este guia para configurar Axiom e Sentry para `development`, `staging`, e `production`.

## Preparar os tokens administrativos

Prepare somente os tokens dos providers selecionados.

1. Crie um personal access token no Axiom.
2. Conceda ao token acesso para gerenciar datasets e API tokens.
3. Copie o identificador da organização Axiom.
4. Crie um organization auth token no Sentry.
5. Conceda ao token os escopos `org:read`, `project:read` e `project:write`.
6. Copie os slugs da organização e do time Sentry.

Não use tokens administrativos no runtime da aplicação. Esses tokens podem alterar recursos da organização.

## Autenticar a CLI

Execute o login do Axiom:

```sh
observability auth login axiom --organization-id <axiom-organization-id>
```

Cole o personal access token no prompt protegido.

Execute o login do Sentry:

```sh
observability auth login sentry \
  --organization maxxi-cash \
  --team backend
```

Cole o organization auth token no prompt protegido.

Valide as conexões salvas:

```sh
observability auth status
```

A saída mostra cada identidade disponível e o caminho do arquivo de credenciais.

## Iniciar a observabilidade local

Inicie o Collector e o viewer:

```sh
observability dev up
```

Configure o serviço local:

```sh
export OTEL_SERVICE_NAME=livro-caixa
export OTEL_SERVICE_INSTANCE_ID=livro-caixa-local-1
export OTEL_DEPLOYMENT_ENVIRONMENT=development
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

`OTEL_SERVICE_INSTANCE_ID` é opcional. Um valor ausente, `undefined` ou vazio omite `service.instance.id`. Um valor não vazio aceita no máximo 128 caracteres.

Abra `http://localhost:8000` para ver os sinais recebidos.

## Provisionar staging e production

Execute o comando no projeto `maxxi-cash/livro-caixa`:

```sh
observability provision \
  --dir . \
  --name livro-caixa \
  --environment staging \
  --environment production \
  --sentry-platform node \
  --axiom-edge-deployment <edge-deployment-id> \
  --axiom-retention-days 30
```

O comando cria estes recursos:

- seis datasets Axiom com kinds corretos, edge deployment explícito e retenção de 30 dias;
- dois tokens Axiom com acesso somente para ingestão;
- um projeto Sentry chamado `livro-caixa`;
- os assets do Collector e do accessory Kamal.

Axiom Correlation exige uma ação manual. Para cada ambiente, crie no Console o grupo, slug e seleção de datasets impressos pela CLI. Depois confirme com uma leitura nova dos datasets:

```sh
observability provision \
  --name livro-caixa \
  --environment staging \
  --provider axiom \
  --axiom-edge-deployment <edge-deployment-id> \
  --axiom-retention-days 30 \
  --correlation-confirmed
```

A CLI não usa endpoints não documentados e não afirma que verificou o grupo remoto. Sem essa confirmação, `env export` permanece bloqueado.

O comando não imprime os tokens de runtime.

Para configurar somente Axiom, adicione `--provider axiom`. Para configurar somente Sentry, adicione `--provider sentry`.

Para selecionar ambos explicitamente, repita a flag:

```sh
observability provision \
  --name livro-caixa \
  --environment staging \
  --provider axiom \
  --provider sentry
```

Sem a flag, um ambiente novo usa ambos. Um ambiente existente repete seus providers salvos.

## Adicionar as variáveis ao deploy

Exporte as variáveis de `staging`:

```sh
observability env export \
  --name livro-caixa \
  --environment staging
```

A saída contém somente variáveis dos providers salvos. Não salve essa saída em um arquivo versionado.

Adicione os valores ao gerenciador de segredos do ambiente. Adicione variáveis Axiom ao destino Kamal somente quando o ambiente usa Axiom.

Repita o processo para `production`:

```sh
observability env export \
  --name livro-caixa \
  --environment production
```

Mescle `observability/kamal.accessory.yml` em `config/deploy.yml`. O accessory lê os nomes dos datasets das variáveis exportadas.

## Inspecionar a configuração

Liste todos os ambientes configurados:

```sh
observability env list --name livro-caixa
```

A lista mostra os datasets Axiom e o projeto Sentry de cada ambiente.

## Recuperar um token Axiom perdido

Se o arquivo local de credenciais foi perdido, regenere o token do ambiente:

```sh
observability provision \
  --name livro-caixa \
  --environment staging \
  --provider axiom \
  --rotate-token
```

Atualize o segredo `AXIOM_TOKEN` antes do próximo deploy. O token anterior deixa de funcionar imediatamente.

Não execute uma repetição comum após `OBS_CLI_REMOTE_OUTCOME_UNKNOWN`. Use a rotação explícita para recuperar o estado.
