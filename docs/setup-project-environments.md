# Configurar um projeto com ambientes remotos

Use este guia para configurar Axiom e Sentry para `development`, `staging`, e `production`.

## Preparar os tokens administrativos

1. Crie um personal access token no Axiom.
2. Conceda ao token acesso para gerenciar datasets e API tokens.
3. Copie o identificador da organização Axiom.
4. Crie um organization auth token no Sentry.
5. Conceda ao token os escopos `org:read`, `project:read`, e `project:write`.
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

Valide as duas conexões:

```sh
observability auth status
```

A saída mostra a identidade Axiom, a organização Sentry, e o caminho do arquivo de credenciais.

## Iniciar a observabilidade local

Inicie o Collector e o viewer:

```sh
observability dev up
```

Configure o serviço local:

```sh
export OTEL_SERVICE_NAME=livro-caixa
export OTEL_DEPLOYMENT_ENVIRONMENT=development
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Abra `http://localhost:8000` para ver os sinais recebidos.

## Provisionar staging e production

Execute o comando no projeto `maxxi-cash/livro-caixa`:

```sh
observability provision \
  --dir . \
  --name livro-caixa \
  --environment staging \
  --environment production \
  --sentry-platform node
```

O comando cria estes recursos:

- seis datasets Axiom;
- dois tokens Axiom com acesso somente para ingestão;
- um projeto Sentry chamado `livro-caixa`;
- os assets do Collector e do accessory Kamal.

O comando não imprime os tokens de runtime.

## Adicionar as variáveis ao deploy

Exporte as variáveis de `staging`:

```sh
observability env export \
  --name livro-caixa \
  --environment staging
```

A saída contém `AXIOM_TOKEN` e `SENTRY_DSN`. Não salve essa saída em um arquivo versionado.

Adicione os valores ao gerenciador de segredos do ambiente. Adicione as variáveis `OTEL_*` e `AXIOM_DATASET_*` ao destino Kamal.

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
  --rotate-token
```

Atualize o segredo `AXIOM_TOKEN` antes do próximo deploy. O token anterior deixa de funcionar imediatamente.
