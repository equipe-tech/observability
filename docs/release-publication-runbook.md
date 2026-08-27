# Publicação coordenada dos pacotes

Este runbook prepara uma publicação, mas separa todas as mutações por um gate humano explícito. Os comandos usam `0.2.0` e `v0.2.0`; substitua ambos somente depois de uma nova análise semver e revisão dos manifests.

## Invariantes

- `@equipe-tech/observability` e `@equipe-tech/observability-cli` usam exatamente a mesma versão.
- Um único tag anotado `v0.2.0` aponta para o commit aprovado que contém os dois manifests e as notas.
- O commit aprovado está no histórico de `origin/master` antes da criação do tag.
- Os tarballs aprovados contêm READMEs, licença Apache-2.0, declarações, entrypoints e assets esperados.
- O workflow usa OpenID Connect com `id-token: write` e `npm publish --provenance`.
- Nenhum comando de mutação desta página roda sem aprovação do responsável pela release.

## Preflight sem mutação externa

```sh
set -euo pipefail
git fetch origin --tags --prune
git status --short --branch
test -z "$(git status --porcelain)"
test "$(jq -r .version packages/telemetry/package.json)" = "0.2.0"
test "$(jq -r .version packages/cli/package.json)" = "0.2.0"
test -z "$(git tag --list v0.2.0)"
npm view @equipe-tech/observability version dist-tags versions --json
npm view @equipe-tech/observability-cli version dist-tags versions --json
bun scripts/release.ts 0.2.0 --dry-run
bun check
bun run build
bun run test
bun run test:package
```

Valide os assets no Collector 0.159.0:

```sh
docker run --rm \
  -v "$PWD/packages/cli/src/assets/local.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.159.0 \
  validate --config=/etc/otelcol/config.yaml

docker run --rm \
  -e AXIOM_TOKEN=test \
  -e AXIOM_DATASET_TRACES=traces \
  -e AXIOM_DATASET_LOGS=logs \
  -e AXIOM_DATASET_METRICS=metrics \
  -v "$PWD/packages/cli/src/assets/production.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.159.0 \
  validate --config=/etc/otelcol/config.yaml

recovery_root="$(mktemp -d)"
OBSERVABILITY_COLLECTOR_RECOVERY=1 \
OBSERVABILITY_COLLECTOR_RECOVERY_ARTIFACT_ROOT="$recovery_root" \
  bun test packages/cli/test/CollectorRecovery.bun.test.ts --timeout 120000
```

Rode o canário local sem credenciais com um único diretório de estado:

```sh
state="$(mktemp -d)"
OBSERVABILITY_HOME="$state" bun packages/cli/src/main.ts dev up
trap 'OBSERVABILITY_HOME="$state" bun packages/cli/src/main.ts dev down' EXIT
curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 1 \
  http://localhost:8000/ >/dev/null
OBSERVABILITY_HOME="$state" OBSERVABILITY_E2E=1 bun test:canary
OBSERVABILITY_HOME="$state" bun packages/cli/src/main.ts dev down
trap - EXIT
```

## Tarballs aprováveis

```sh
set -euo pipefail
artifact_dir="$(mktemp -d)"
bun run build
(
  cd packages/telemetry
  bun pm pack --ignore-scripts --quiet \
    --filename "$artifact_dir/equipe-tech-observability-0.2.0.tgz"
)
(
  cd packages/cli
  bun pm pack --ignore-scripts --quiet \
    --filename "$artifact_dir/equipe-tech-observability-cli-0.2.0.tgz"
)
tar -tzf "$artifact_dir/equipe-tech-observability-0.2.0.tgz" | sort
tar -tzf "$artifact_dir/equipe-tech-observability-cli-0.2.0.tgz" | sort
shasum -a 256 "$artifact_dir"/*.tgz
npm publish "$artifact_dir/equipe-tech-observability-0.2.0.tgz" \
  --access public --tag latest --provenance --dry-run
npm publish "$artifact_dir/equipe-tech-observability-cli-0.2.0.tgz" \
  --access public --tag latest --provenance --dry-run
```

Registre os SHA-256. Confira nomes e versões dos manifests empacotados, export maps, todos os `.d.ts`, modo executável da CLI, assets do Collector e Kamal, READMEs, licenças, dependency ranges e ausência de `workspace:`, fontes, testes, credenciais e arquivos alheios.

Instale esses mesmos tarballs em diretórios temporários Node e Bun. Importe raiz, metrics, node, nestjs, browser, browser/client e testing. Compile consumidores NestJS 10 e 11, execute o cliente de browser empacotado e confirme o gate gzip. Execute `observability --help`, `dev status` e provisionamento local. `bun run test:package` automatiza essa matriz; uma instalação Node separada confirma a resolução fora do Bun.

## Evidência para aprovação

Entregue ao responsável:

- SHA completo do commit candidato e confirmação de que ele pertence a `origin/master`;
- diff desde `v0.1.0` e notas `docs/releases/v0.2.0.md`;
- saídas de check, build, testes, smoke, Collector, recovery e canário local;
- listagens e SHA-256 dos dois tarballs;
- saídas dos dois `npm publish --dry-run`;
- resultado das instalações externas Node, Bun, NestJS 10 e NestJS 11;
- resultado das consultas read-only de versões e dist-tags;
- revisão das permissões OIDC e do comando `--provenance`.

## Gate humano de publicação

Pare aqui. Os comandos abaixo criam ou propagam estado externo. Execute somente depois que o responsável aprovar por escrito o SHA, a versão, as notas, os hashes, a conta npm, o dist-tag `latest` e a configuração de proveniência.

```sh
set -euo pipefail
git fetch origin --tags --prune
approved_sha="<SHA_APROVADO>"
test "$(git rev-parse "$approved_sha")" = "$approved_sha"
git merge-base --is-ancestor "$approved_sha" origin/master
test "$(git show "$approved_sha:packages/telemetry/package.json" | jq -r .version)" = "0.2.0"
test "$(git show "$approved_sha:packages/cli/package.json" | jq -r .version)" = "0.2.0"
test -z "$(git ls-remote --tags origin refs/tags/v0.2.0 refs/tags/v0.2.0^{})"
git tag -a v0.2.0 "$approved_sha" -m "Release 0.2.0"
git push origin v0.2.0
```

O push do tag aciona o workflow. Não rode `npm publish`, `gh release create`, upload de asset ou alteração de dist-tag manual em paralelo.

## Verificação após publicação

```sh
git ls-remote --tags origin refs/tags/v0.2.0 refs/tags/v0.2.0^{}
gh release view v0.2.0 --json tagName,isDraft,isPrerelease,assets,url
npm view @equipe-tech/observability@0.2.0 version dist.integrity dist.shasum --json
npm view @equipe-tech/observability-cli@0.2.0 version dist.integrity dist.shasum --json
npm view @equipe-tech/observability dist-tags --json
npm view @equipe-tech/observability-cli dist-tags --json
```

Confirme dois assets no GitHub Release, proveniência nos dois pacotes npm, `latest: 0.2.0` em ambos e instalação limpa por versão em Node e Bun.

## Falha e rollback

- Antes do tag, corrija no branch, repita toda a validação, gere novos hashes e peça nova aprovação do SHA.
- Se o tag remoto existir mas o GitHub Release e os dois pacotes ainda não tiverem sido publicados, cancele o workflow. Remova eventual draft e o tag somente com aprovação explícita. Nunca mova um tag de release publicado.
- Se somente um pacote for publicado, preserve a versão publicada. Corrija a causa e reexecute o workflow por `workflow_dispatch` com o tag existente para publicar o pacote ausente. O workflow ignora de forma idempotente uma versão já publicada.
- Se um pacote publicado tiver defeito, faça uma correção coordenada com nova versão patch nos dois pacotes. Não reutilize `0.2.0`.
- Não use `npm unpublish` como rollback normal. `npm deprecate` ou mudança manual de dist-tag exigem aprovação explícita, mensagem de substituição e verificação dos dois pacotes.
- Preserve logs do workflow, SHA aprovado, hashes locais, integrities npm e URL do release como evidência do incidente.
