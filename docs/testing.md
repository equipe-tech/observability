# Testes

## Estratégia

Este projeto prefere testes de integração contra a superfície real a qualquer outra forma de teste. A suíte de aceitação exercita o pipeline completo de telemetria: aplicação -> OTel Collector -> destino -> consulta -> verificação.

Uma feature não está completa somente porque um teste unitário ou um teste de integração local a cobre.

Aplicações executam a [suíte reutilizável de conformidade](conformance.md) para agregar perfil, contrato, manifesto, adapters, política, auditoria, fronteiras de pacote e canários em um relatório estável.

## Cobertura exigida

Cada feature pública e cada endpoint devem ter cobertura de ponta a ponta para:

- comportamento de sucesso;
- entrada externa malformada;
- cada contrato de erro alcançável pelo chamador;
- persistência entre requisições, quando aplicável;
- garantias de idempotência e transições de estado;
- comportamento relevante de concorrência e recuperação.

## Alvos de teste

- `local` roda as mesmas suítes de feature contra o Collector local com destino local (viewer ou exporter de arquivo). É o loop rápido de desenvolvimento e depuração.
- `deployed` roda contra destinos reais (dataset E2E no Axiom) e é a fronteira de aceitação.

As suítes de feature consomem o mesmo cliente nos dois alvos. Deploy, prontidão, autenticação e teardown pertencem ao harness, não às suítes.

## Canário do pipeline

O pacote inclui um teste canário que valida o pipeline completo:

1. Emite um trace com identidade única (test run id).
2. Aguarda a exportação com flush limitado.
3. Consulta o destino pela identidade.
4. Verifica `trace_id`, `span_id` e a relação de parentesco entre os spans.
5. Verifica os atributos de resource (`service.name`, `service.version`, ambiente).

O canário falha quando qualquer etapa do pipeline quebra, mesmo que cada componente pareça saudável de forma isolada.

## Isolamento

- Cada execução E2E usa uma identidade única e DNS-safe (`test-<user>-<timestamp>-<entropy>`).
- Testes E2E nunca escrevem em datasets de produção.
- O teardown remove os dados do teste. Um cleanup externo cobre execuções interrompidas.

## Contabilidade de caminhos de erro

Ao declarar um comportamento completo, enumere os caminhos de erro do contrato e aponte o teste que cobre cada um. Um caminho de erro sem teste é trabalho incompleto.
