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

O workflow gerado usa GitHub Environments nos jobs `verify-providers` e `release-canary`. Tokens administrativos `OBSERVABILITY_AXIOM_AUTH_TOKEN` e `SENTRY_AUTH_TOKEN`, o comando de canário e endpoints application-owned não fazem parte da sincronização automática. Cadastre-os diretamente no ambiente protegido com acesso mínimo; a CLI sincroniza somente os secrets de runtime `AXIOM_TOKEN` e o nome customizado de DSN registrado pelo setup. Ele é iniciado por `workflow_dispatch` com o ambiente protegido e o `deployed_ref` imutável que a automação de deploy da aplicação já concluiu. A remoção do trigger por tag exige migração explícita: o deploy application-owned deve despachar o workflow somente depois de provar o ref em execução. O setup preserva arquivos gerados modificados ou desconhecidos pelas regras normais de conflito. O workflow não executa deploy. Checkout, identidade OpenTelemetry, upload de source maps e canários usam o mesmo `deployed_ref`. O job de canário mapeia identidade, variável customizada de release, ambiente, endpoint OTLP, datasets, rollout e secrets de runtime; o deploy da aplicação deve mapear o mesmo contrato.

Novos bootstraps Node, NestJS e browser iniciam desabilitados enquanto `OBSERVABILITY_TELEMETRY_ROLLOUT` não for exatamente `enabled`. Nesse estado, os handles Node e NestJS são inertes, o módulo NestJS não registra a rota de ingestão e o browser não instala listeners, exporters, métricas ou Sentry. O job `release-canary` também exige a variável do GitHub Environment com valor `enabled`. Prepare o ambiente com `env github plan --rollout disabled`, aprove o deploy da aplicação em escopo separado e só então gere e aplique um novo plano com `--rollout enabled --approve-rollout`. Alterar a variável no GitHub não altera processos em execução: depois do apply, faça um redeploy ou restart aprovado, prove a identidade e o rollout efetivo do novo processo e só então execute o canário.

O job de providers usa um diretório `OBSERVABILITY_HOME` isolado. Portanto confirmações manuais e configuração gerenciada salvas no host do operador não aparecem no runner. O gate remoto exige `OBSERVABILITY_MANAGED_ENVIRONMENT_EVIDENCE`, uma cópia revisada do documento de credenciais contendo os ambientes gerenciados sem credenciais administrativas, e `OBSERVABILITY_OPERATIONS_EVIDENCE`, o estado de operações aprovado para o serviço. Cadastre ambos como secrets do Environment. O workflow os restaura com `umask 077` antes dos logins e de `ops verify`; sem essa evidência o job permanece bloqueado, nunca ignora a confirmação. `OBSERVABILITY_AXIOM_AUTH_TOKEN` e `SENTRY_AUTH_TOKEN` devem ser credenciais CI de leitura com a menor permissão possível, cadastradas separadamente no GitHub Environment. `env github` não sincroniza nem inventa esses tokens administrativos.

Cada binding da variável de segredo fica restrito ao passo de login correspondente. Cada binding da variável de segredo fica restrito ao passo de login correspondente. O login persiste o token no arquivo efêmero de credenciais, que continua disponível para a verificação de providers até o passo de cleanup com `always()`. Os jobs de build e canários não compartilham esse filesystem. O descarte do runner hospedado cobre cancelamentos que impeçam o cleanup.

Os comandos de login são:

```sh
observability auth login axiom --organization-id acme --token-env OBSERVABILITY_AXIOM_AUTH_TOKEN
observability auth login sentry --organization acme --team frontend --token-env SENTRY_AUTH_TOKEN
```

Sem `--token-env`, os comandos mantêm o prompt protegido. Com a flag, uma variável ausente, vazia ou inválida falha antes de qualquer acesso ao provider ou gravação local.

Registros v1 continuam legíveis para verificação local. A verificação de release permanece bloqueada até um `setup write` explícito gravar as declarações v2. Arquivos de canário legados modificados são preservados durante essa gravação.
