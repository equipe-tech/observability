# Compatibilidade de contratos e pacotes

`bun run compat` compara a candidata com `observability/compatibility/baseline.json`. O baseline identifica o tag e o commit publicados. `bun scripts/generate-compatibility-baseline.ts` o reconstrói do tag exato. `bun scripts/generate-compatibility-candidate.ts` reconstrói `candidate.json` do contrato compilado, do manifesto de operações e dos schemas do browser. O gate faz a mesma geração e exige igualdade byte a byte. Versões de release ainda não gravadas nos manifests ficam em `candidate-versions.json`. `declared-breaks.json` registra somente quebras intencionais com código, caminho exato, pacote, versão e guia de migração.

## Contrato

A suíte `tools/compatibility.bun.test.ts` executa uma fixture positiva e um controle próximo para cada literal de `Contract.CompatibilityCode`. As fixtures chamam `Contract.classifyContractChange` e validam código, caminho, severidade, status de alias e aceitação. A igualdade exata entre IDs únicos de fixture e os literais do schema impede códigos ausentes ou extras.

`Contract.contractSurface` gera o artefato estrito na versão 1. Ele contém eventos, significado de resultados, atributos, métricas, ações de auditoria, aliases, envelope do browser e a maior retenção declarada pelo manifesto. `Contract.encodeContractSurface` e `Contract.decodeContractSurface` mantêm a representação determinística.

Adições de eventos, atributos opcionais e métricas são compatíveis. Remoções, renomes, atributos obrigatórios novos, mudanças de classificação, tipo de evento, significado de resultado, unidade, tipo ou limites de métrica são quebras. Toda quebra exige `contractVersion` maior que o baseline.

Aliases ligam somente nomes equivalentes. Cada alias exige `since` em `YYYY-MM-DD`. O alvo de evento mantém tipo, atributos e classificações. O alvo de métrica mantém tipo, unidade e atributos. Uma mudança semântica usa um nome novo e mantém o sinal antigo consultável sem alias até o fim da retenção.

O gate congela `retentionWindowDays` no baseline. Ele rejeita redução da janela, mudança de `since` e remoção antes de `since + retentionWindowDays`. Nos sete dias finais o status é `expiring`. No limite da janela o status passa a `expired`.

Queries de dashboard e monitor que usam a origem antiga declaram o predicado com a origem e todos os alvos. O parser do manifesto valida essa igualdade antes de qualquer chamada a provider. Depois do vencimento, migre produtores e queries, remova a origem antiga e só então remova o alias.

Mudanças nos campos do envelope do browser exigem uma versão de envelope maior. O decoder aceita qualquer versão inteira positiva segura. O cliente atual envia a versão 2; lotes da versão 1 continuam válidos.

## Pacotes

A mesma suíte executa uma fixture positiva e um controle para cada literal de `PackageCompatibilityCode`. Ela usa `classifyPackageChange` e valida código, caminho, severidade e satisfação. Um sensor altera cada valor esperado em memória e prova que o matcher rejeita a expectativa incorreta.

O gate fixa nome, tipo de módulo, exports, entrypoints em runtime, símbolos alcançáveis nas declarações, dependências, peers, peers opcionais e códigos públicos de erro. Export novo é compatível. Remoção de export ou símbolo, entrypoint ausente, peer alterado e mudança entre dependência direta e peer são quebras. Uma declaração de quebra vale para um único código e caminho exato.

Na linha `0.x`, uma quebra exige minor maior. A partir de `1.0.0`, exige major maior. A quebra `0.2.1` para `0.3.0` está declarada em `declared-breaks.json` e documentada em `migration-0.3.md`. O feature não altera versões nos manifests. A release aplica `candidate-versions.json`.

CI deriva a data de compatibilidade da data do commit e executa o gate depois do build. O preflight executa o mesmo gate em modo de release antes de empacotar. Para um pacote já publicado, o preflight baixa o tarball anterior, extrai a mesma representação canônica de pacote e compara o digest com o baseline do tag. A primeira publicação exige a declaração exata da candidata e não procura um tarball anterior. `release.yml` herda o gate pelo workflow de CI.
