# Publicação independente dos pacotes

Cada pacote tem versão, tag, notas, checksum, archive e publicação próprios. O tag usa `<slug>@<semver>`:

- `observability@0.3.0`
- `observability-evlog@0.3.0`
- `observability-nestjs@0.3.0`
- `observability-cli@0.2.1`

Tags `v*` pertencem ao histórico da linha coordenada 0.2 e não acionam o workflow atual. Os registros `docs/releases/v0.2.0.sha256` e `docs/releases/v0.2.1.sha256` preservam os checksums históricos dessa linha e não são entradas do fluxo independente.

## Preflight

Execute o workflow `Release Preflight` com o slug e a versão exata antes de criar o tag. O job valida o manifest, executa o dry run, compila o workspace, cria um archive específico do pacote em um diretório isolado, gera notas e checksum, verifica o checksum e executa o smoke de pacotes. A consulta ao npm aceita somente dois resultados: a versão já existe ou o registry respondeu `E404`. Falhas de rede e autenticação interrompem o preflight.

O preflight não depende de arquivos existentes em `docs/releases`. Para reproduzi-lo localmente:

```sh
bun scripts/release.ts 0.3.0 --package observability --dry-run
bun check
bun run test
bun run build
output="$(mktemp -d)"
bun scripts/release-candidate.ts --package observability --version 0.3.0 --output "$output"
(cd "$output" && sha256sum --check observability@0.3.0.sha256)
bun run test:package
```

O dry run não altera manifest, lockfile, commit ou tag. Uma release real altera somente o manifest selecionado. O script cria um tag no formato `<slug>@<versão>` e nunca atualiza um pacote irmão.

## Verificar os archives

`bun run test:package` compila e empacota os quatro pacotes. O smoke instala os archives em consumidores Node e Bun, testa NestJS 10 e 11, percorre as declarações, rejeita imports não declarados e confirma os entrypoints públicos.

`release-candidate.ts` empacota a candidata duas vezes e exige bytes idênticos. O job de publicação reconstrói a candidata a partir do checkout do tag, verifica o checksum gerado e compara os bytes reconstruídos com o asset baixado do GitHub antes de publicar no npm.

## Gate humano

O push de um tag apenas executa verificação. A publicação exige `workflow_dispatch` no ref exato do tag, `tag` e `confirm_tag` idênticos e aprovação do environment `publication`.

O workflow resolve o slug para um único manifest. Ele empacota, cria release e publica somente esse pacote. O job de npm exige `NPM_TOKEN`, identidade OIDC e `npm publish --provenance`.

## Falha parcial e nova execução

Uma nova execução converge sobre o estado existente. Se a GitHub Release já existe, o workflow a reutiliza e substitui somente o asset selecionado depois de reconstruí-lo. Se a versão já existe no npm, o workflow verifica esse estado e encerra a etapa sem publicar outra vez.

Se a criação da release concluir e o npm falhar, corrija a causa e execute novamente o mesmo `workflow_dispatch` no mesmo tag. Não mova o tag e não crie outro archive manualmente. Falhas de rede ou autenticação na consulta ao npm não são tratadas como versão ausente.

## Rollback

Nunca remova uma versão publicada do npm e nunca mova um tag publicado. Se a falha ocorrer antes da publicação no npm, mantenha o tag e a release para diagnóstico, corrija o workflow ou as credenciais e execute novamente. Se um pacote incorreto chegar ao npm, descontinue a versão com `npm deprecate`, corrija o código e publique um novo patch apenas para o pacote afetado. Registre na release anterior o link para a versão corrigida.

Não publique um pacote irmão para alinhar versões.
