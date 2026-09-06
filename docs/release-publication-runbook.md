# Publicação independente dos pacotes

Cada pacote tem versão, tag, notas, checksum, archive e publicação próprios. O tag usa `<slug>@<semver>`:

- `observability@0.3.0`
- `observability-evlog@0.3.0`
- `observability-nestjs@0.3.0`
- `observability-sentry@0.3.0`
- `observability-react@0.3.0`
- `observability-cli@0.3.0`

Tags `v*` pertencem ao histórico da linha coordenada 0.2 e não acionam o workflow atual. Os registros `docs/releases/v0.2.0.sha256` e `docs/releases/v0.2.1.sha256` preservam os checksums históricos dessa linha e não são entradas do fluxo independente.

## Preflight

Execute o workflow `Release Preflight` com o slug e a versão exata antes de criar o tag. O job valida o manifest, executa o dry run, compila o workspace, cria um archive específico do pacote em um diretório isolado, gera notas e checksum, verifica o checksum e executa o smoke de pacotes. A consulta ao npm aceita somente dois resultados: a versão já existe ou o registry respondeu `E404`. Falhas de rede e autenticação interrompem o preflight.

O preflight executa `bun run compat --release <slug>@<versão>` depois do build. O comando usa o baseline exato de `v0.2.1`, gerado das declarações dos tarballs npm publicados, e valida a versão candidata, as quebras declaradas e o guia de migração antes de criar o archive. Para pacotes já publicados, o gate consulta o packument diretamente, valida a integridade do tarball anterior, rejeita caminhos inseguros e links e compara sua superfície canônica com o digest congelado no baseline.

Execute o preflight no branch `master`. Depois da validação local, aprove o job direto `deployed-canary` no environment `publication`. O job usa o commit imutável da execução, não um tag existente. O gate exige sucesso explícito antes de considerar o preflight aprovado. O preflight nunca publica pacotes.

Permita `master` e os padrões de tags de pacote na política de branches do environment. Mantenha a aprovação obrigatória. Os jobs protegidos permanecem diretos nos dois workflows para preservar a resolução dos secrets de environment.

O preflight não depende de arquivos existentes em `docs/releases`. Para reproduzir a parte local:

```sh
bun scripts/release.ts 0.3.0 --package observability --dry-run
bun check
bun run test
bun run build
OBSERVABILITY_COMPATIBILITY_DATE="$(date -u +%F)" bun run compat --release observability@0.3.0
output="$(mktemp -d)"
bun scripts/release-candidate.ts --package observability --version 0.3.0 --output "$output"
(cd "$output" && sha256sum --check observability@0.3.0.sha256)
bun run test:package
```

O dry run não altera manifest, lockfile, commit ou tag. Uma release real altera somente o manifest selecionado. O script cria um tag no formato `<slug>@<versão>` e nunca atualiza um pacote irmão.

## Verificar os archives

`bun run test:package` compila e empacota os seis pacotes. O smoke instala os archives em consumidores Node e Bun, testa NestJS 10 e 11, percorre as declarações, rejeita imports não declarados e confirma os entrypoints públicos.

`release-candidate.ts` empacota a candidata duas vezes e exige bytes idênticos. O job de publicação reconstrói a candidata a partir do checkout do tag, verifica o checksum gerado e compara os bytes reconstruídos com o asset baixado do GitHub antes de publicar no npm.

## Gate do canário no provedor

A verificação de release executa o canário implantado antes de criar a GitHub Release. O job `deployed-canary` roda diretamente em `release.yml`, depois da verificação reutilizável de `ci.yml`, e usa o environment protegido `publication` como a única origem dos secrets. Isso evita a falha de resolução de secrets de environment na fronteira de workflows reutilizáveis descrita em [actions/runner#4453](https://github.com/actions/runner/issues/4453). CI continua reutilizável, sem receber secrets ou `NPM_TOKEN`; não use `secrets: inherit`. O gate exige sucesso explícito desse job antes da GitHub Release e da publicação npm. Falha, cancelamento, execução omitida ou resultado ausente não permitem publicação. O job exige dois secrets independentes:

- `AXIOM_INGEST_TOKEN` aceita somente ingestão nos datasets E2E de traces, logs e métricas.
- `AXIOM_READ_TOKEN` aceita somente consultas nos mesmos datasets E2E.

`AXIOM_ORGANIZATION_ID`, `AXIOM_URL`, `AXIOM_DATASET_TRACES`, `AXIOM_DATASET_LOGS` e `AXIOM_DATASET_METRICS` são variables do environment. `AXIOM_URL` aponta para a API regional da organização. Nenhum token administrativo entra no job.

O canário usa `/v1/query/_apl` nos domínios regionais `*.edge.axiom.co` e mantém `/v1/datasets/_apl` na API global. Os domínios regionais não oferecem a rota global. Ambas as consultas APL solicitam o formato `legacy` esperado pelo parser do teste.

O [preflight protegido de 6 de setembro de 2026](https://github.com/equipe-tech/observability/actions/runs/34063620778) confirmou schemas distintos. Logs expõem atributos como `attributes.canary.run_id`; traces usam o mapa `attributes.custom`. Ambos expõem `service.namespace` e `resource.deployment.environment.name`. O alias legado do ambiente permanece em `resource.custom` nos traces e em `resource.deployment.environment` nos logs. A fixture `packages/telemetry/test/fixtures/axiom-canary-schema.json` preserva somente nomes e tipos das colunas observadas.

O identificador opcional de instância pode não existir no schema de logs. A consulta usa `column_ifexists` sem substituir campos obrigatórios. O decoder trata o resultado vazio de `tostring(null)` como ausência. Um identificador não vazio continua visível e reprova a política do canário.

O script `scripts/release-canary.ts` resolve o tag para o manifest correspondente e define `OTEL_SERVICE_VERSION` com a versão desse manifest. O step do Collector recebe somente `AXIOM_INGEST_TOKEN`. O step de consulta recebe somente `AXIOM_READ_TOKEN`. O canário consulta traces, logs e métricas usando a versão e os valores de correlação da execução. A ausência de qualquer secret encerra o gate com `OBS_RELEASE_CANARY_CREDENTIALS_MISSING`. CI comum permanece sem credenciais e informa que o gate protegido pertence ao workflow de release.

Quando o canário falha, `scripts/axiom-schema.ts` consulta `getschema` nos datasets E2E de traces e logs. O diagnóstico imprime somente nomes e tipos de colunas validados, nunca eventos, credenciais ou corpos de erro do provedor. Cada consulta tem timeout de dez segundos. Respostas malformadas ou com mais de 512 colunas falham explicitamente. O diagnóstico não converte a falha do canário em sucesso.

O canário distingue os dois marcadores da política do Collector. Atributos com chaves sensíveis exigem `****`. O valor textual de `safe.message` exige exatamente `token="[REDACTED]"`, produzido pelo transform de pares chave-valor. As verificações locais e implantadas exigem ausência de todos os valores sensíveis originais.

O orçamento de visibilidade reserva 200 ms para o `flush_timeout` do Collector e 180.000 ms para `axiomQueryVisibilityMilliseconds`. A [documentação pública de ingestão do Axiom](https://axiom.co/docs/send-data/) não publica um limite de latência entre ingestão e consulta. Por isso, os 180 segundos são uma tolerância operacional explícita, não uma garantia do provedor. O teste exige que o intervalo total de polling cubra esses dois campos e informa a margem derivada. Com os valores atuais, o intervalo de 192.000 ms deixa uma margem de 11.800 ms.

Se o gate falhar, preserve o tag e os resultados da execução. Corrija a credencial, a variable regional, o dataset ou a entrega de telemetria indicada pelo último resultado de consulta. Para correções de configuração externa, execute novamente o mesmo workflow no mesmo tag. Se a correção exigir mudanças versionadas, valide primeiro o candidato com o preflight protegido em `master`. Depois do sucesso, prepare um novo patch apenas do pacote afetado com um novo tag. A execução no tag anterior continua usando os arquivos antigos. Não mova o tag, não use credencial administrativa e não publique manualmente para contornar o gate.

## Gate humano

O push de um tag solicita aprovação do environment `publication` e executa somente a verificação protegida depois da aprovação. A publicação exige outro `workflow_dispatch` no ref exato do tag, `tag` e `confirm_tag` idênticos e uma nova aprovação do environment `publication`.

O workflow resolve o slug para um único manifest. Ele empacota, cria release e publica somente esse pacote. O job de npm exige `NPM_TOKEN`, identidade OIDC e `npm publish --provenance`.

## Falha parcial e nova execução

Uma nova execução converge sobre o estado existente. Se a GitHub Release já existe, o workflow a reutiliza e substitui somente o asset selecionado depois de reconstruí-lo. Se a versão já existe no npm, o workflow verifica esse estado e encerra a etapa sem publicar outra vez.

Se a criação da release concluir e o npm falhar, corrija a causa e execute novamente o mesmo `workflow_dispatch` no mesmo tag. Não mova o tag e não crie outro archive manualmente. Falhas de rede ou autenticação na consulta ao npm não são tratadas como versão ausente.

## Rollback

Nunca remova uma versão publicada do npm e nunca mova um tag publicado. Se a falha ocorrer antes da publicação no npm, mantenha o tag e a release para diagnóstico. Correções de credenciais permitem executar novamente; correções versionadas de workflow exigem um novo patch e tag do pacote afetado. Se um pacote incorreto chegar ao npm, descontinue a versão com `npm deprecate`, corrija o código e publique um novo patch apenas para o pacote afetado. Registre na release anterior o link para a versão corrigida.

Não publique um pacote irmão para alinhar versões.
