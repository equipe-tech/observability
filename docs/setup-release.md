# Pré-requisitos de release do setup

Aplicações executáveis declaram a organização Axiom com `--axiom-organization-id`. Aplicações com defeitos também declaram `--sentry-org` e `--sentry-team`.

React com defeitos exige um script existente no `package.json` e ao menos um caminho de saída relativo:

```sh
observability setup write \
  --dir . \
  --profile react-web \
  --service-name checkout \
  --environment production \
  --public-origin https://checkout.example.com \
  --with-defects \
  --axiom-organization-id acme \
  --sentry-org acme \
  --sentry-team frontend \
  --sentry-project checkout \
  --source-map-build-script build \
  --source-map-path dist \
  --install
```

O setup instala `@sentry/cli@3.7.0` somente nessa combinação. O workflow executa o build declarado e depois roda a verificação local sem credenciais:

```sh
bun ./node_modules/@equipe-tech/observability-cli/dist/main.js setup verify-release --dir .
```

A verificação exige `./node_modules/.bin/sentry-cli` resolvido para a dependência exata. Cada caminho declarado deve permanecer dentro da aplicação e conter um bundle JavaScript não vazio e um source map versão 3 válido e não vazio.

O job de providers usa um diretório `OBSERVABILITY_HOME` isolado. Cada token fica restrito ao passo de login correspondente:

```sh
observability auth login axiom --organization-id acme --token-env OBSERVABILITY_AXIOM_AUTH_TOKEN
observability auth login sentry --organization acme --team frontend --token-env SENTRY_AUTH_TOKEN
```

Sem `--token-env`, os comandos mantêm o prompt protegido. Com a flag, uma variável ausente, vazia ou inválida falha antes de qualquer acesso ao provider ou gravação local.

Registros v1 continuam legíveis para verificação local. A verificação de release permanece bloqueada até um `setup write` explícito gravar as declarações v2. Arquivos de canário legados modificados são preservados durante essa gravação.
