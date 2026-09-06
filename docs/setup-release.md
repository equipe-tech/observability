# Pré-requisitos de release do setup

Aplicações executáveis declaram a organização Axiom com `--axiom-organization-id`. Aplicações com defeitos também declaram `--sentry-org` e `--sentry-team`.

`--release-variable` e `--sentry-dsn-variable` selecionam os nomes das variáveis fornecidas pela aplicação. Os bootstraps Node e NestJS mapeiam esses valores para `OTEL_SERVICE_VERSION` e `SENTRY_DSN`, sem alterar o objeto de ambiente recebido. Quando os nomes são customizados, seus valores prevalecem sobre os nomes canônicos presentes no ambiente. O parser do runtime mantém as regras de identidade obrigatória e DSN válido.

O setup preserva bootstraps existentes, inclusive com `--force`. Em aplicações já geradas, ajuste o objeto `env` do bootstrap para mapear os nomes registrados em `observability/setup.json`.

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

A verificação relê o `package.json` da aplicação e exige o script de build não vazio e `@sentry/cli` declarado diretamente como `3.7.0` em `dependencies` ou `devDependencies`. O executável `./node_modules/.bin/sentry-cli` deve ter permissão de execução e resolver para a instalação dessa versão.

Cada caminho declarado deve permanecer dentro da aplicação, sem links nos segmentos ou artefatos, e conter um bundle JavaScript não vazio e um arquivo `.map` não vazio. A verificação faz parse do JSON e exige versão 3, fontes e mappings não vazios, ou seções com offsets inteiros não negativos e mapas com esses campos. Ela não decodifica mappings, valida campos opcionais ou ordenação de seções, nem comprova cobertura, correspondência entre bundle e mapa ou identidade da release. O workflow exige saídas ausentes antes do build e rejeita ancestrais vinculados ou que não sejam diretórios. Essas verificações não protegem contra substituições concorrentes no filesystem.

O job de providers usa um diretório `OBSERVABILITY_HOME` isolado. Cada binding da variável de segredo fica restrito ao passo de login correspondente. O login persiste o token no arquivo efêmero de credenciais, que continua disponível para a verificação de providers até o passo de cleanup com `always()`. Os jobs de build e canários não compartilham esse filesystem. O descarte do runner hospedado cobre cancelamentos que impeçam o cleanup.

Os comandos de login são:

```sh
observability auth login axiom --organization-id acme --token-env OBSERVABILITY_AXIOM_AUTH_TOKEN
observability auth login sentry --organization acme --team frontend --token-env SENTRY_AUTH_TOKEN
```

Sem `--token-env`, os comandos mantêm o prompt protegido. Com a flag, uma variável ausente, vazia ou inválida falha antes de qualquer acesso ao provider ou gravação local.

Registros v1 continuam legíveis para verificação local. A verificação de release permanece bloqueada até um `setup write` explícito gravar as declarações v2. Arquivos de canário legados modificados são preservados durante essa gravação.
