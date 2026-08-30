# Publicação independente dos pacotes

Cada pacote tem versão, tag, notas, checksum, archive e publicação próprios. O tag usa `<slug>@<semver>`:

- `observability@0.3.0`
- `observability-nestjs@0.3.0`
- `observability-cli@0.2.1`

Tags `v*` pertencem ao histórico da linha coordenada 0.2 e não acionam o workflow atual.

## Preparar um pacote

```sh
bun scripts/release.ts patch --package observability-cli --dry-run
bun scripts/release.ts 0.3.0 --package observability --dry-run
bun check
bun run test
bun run build
bun run test:package
```

O dry run não altera manifest, lockfile, commit ou tag. Antes de uma release real, confirme que somente o manifest selecionado muda. O script cria um tag no formato `<slug>@<versão>` e nunca atualiza um pacote irmão.

Crie as notas em `docs/releases/<slug>@<versão>.md` e o checksum em `docs/releases/<slug>@<versão>.sha256`. O checksum contém somente o archive daquele pacote.

## Verificar os archives

`bun run test:package` compila e empacota os três pacotes. O smoke instala os archives em consumidores Node e Bun, testa NestJS 10 e 11, percorre as declarações, rejeita imports não declarados e confirma os entrypoints públicos.

Para a candidata selecionada, gere três archives em diretórios vazios. Compare `pack-1` com `pack-2` e `pack-3`. Valide a lista de arquivos, o manifest empacotado, a licença, o README, as declarações e o checksum específico do tag.

## Gate humano

O push de um tag apenas executa verificação. A publicação exige `workflow_dispatch` no ref exato do tag, `tag` e `confirm_tag` idênticos e aprovação do environment `publication`.

O workflow resolve o slug para um único manifest. Ele empacota, cria release e publica somente esse package. O job de npm exige `NPM_TOKEN`, identidade OIDC e `npm publish --provenance`.

Não mova um tag publicado. Não publique um pacote irmão para alinhar versões. Uma correção usa um novo patch somente no pacote afetado.
