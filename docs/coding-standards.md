# Padrões de código

## Fronteiras do monorepo

Trate cada workspace em `apps/*` como uma raiz de composição executável ou implantável de forma independente. Um app pode depender de pacotes externos e de workspaces em `packages/*`. Um app nunca importa de outro app, não declara dependência de workspace sobre outro app e não alcança outro app por caminho relativo. A regra vale para código de produção, scripts e testes.

Workspaces em `packages/*` contêm capacidades compartilhadas pelos apps e não importam de `apps/*`. Comportamento entre apps passa por uma interface real de runtime, como HTTP, ou por um pacote compartilhado com um entrypoint público intencional.

Mantenha o código no app dono enquanto ele tem um consumidor. Quando outro app precisa da mesma capacidade, mova a capacidade para um pacote coeso e faça os dois apps dependerem dele. Não crie um pacote para antecipar reuso hipotético.

Declare cada aresta de dependência entre workspaces no `package.json` do workspace que importa. O Vite Task usa esse grafo para agendar tarefas.

## Parse, não valide

Faça o parse de cada valor assim que ele cruza uma fronteira de I/O. Trate HTTP, RPC, persistência, configuração, arquivos, filas, APIs de plataforma e clientes de terceiros como fontes de representações externas não confiáveis, mesmo quando as declarações TypeScript afirmam o contrário.

O parse deve retornar um tipo de domínio validado e com significado. Não faça uma checagem booleana e continue passando adiante o valor primitivo ou o tipo de transporte original. Codifique as restrições em schemas, branded types, smart constructors e uniões discriminadas, para que estados inválidos não entrem nos módulos internos.

Construa cada parser de schema uma vez, no escopo do módulo, ao lado do schema dono. Dê ao parser um nome de domínio e exporte-o quando outras fronteiras fazem o parse da mesma representação.

## Tipos

As regras de lint em `tools/oxlint/` aplicam estes padrões:

- Não use `Record`. Modele os campos como um tipo de domínio nomeado.
- Não use parâmetros `object` ou `unknown`. A exceção é `cause` em erros. Decodifique o valor com um schema na fronteira.
- Não use asserções de tipo (`as`). Não encadeie asserções (`as unknown as T`). Faça o parse.
- Não crie aliases que só renomeiam `unknown`.
- Não use `typeof` em runtime para estreitar valores. Decodifique na fronteira.
- Não nomeie símbolos com "shape". Nomeie o conceito de domínio.
- Não use spread condicional de objeto vazio (`...(cond ? { x } : {})`). Construa o objeto em etapas claras.

## Effect

O projeto usa Effect v4. Antes de escrever código Effect, inspecione `repos/effect/` para uso idiomático e leia a orientação para agentes do próprio repositório quando existir.

- Modele capacidades como services e componha com Layers. Código de produção resolve capacidades pela camada de serviço; construção direta (`make<Capability>`) é reservada a testes.
- Use `Option` para valores opcionais em vez de `null` ou `undefined` em contratos de domínio.
- Modele falhas como erros tipados no canal de erro. Reserve defeitos para bugs.
- Use `Schema` para toda fronteira de I/O.
- Não deixe promises soltas. Integre código assíncrono externo com os construtores do Effect.

## Nomeação

Nomeie símbolos pelo conceito de domínio que representam, não pela estrutura de dados. Um nome deve permitir prever o conteúdo sem ler a implementação. Mantenha um termo por conceito no projeto inteiro.

## Imports

- Importe de entrypoints públicos dos pacotes, nunca de caminhos internos de outro workspace.
- Não importe de `repos/`.
- Use extensões `.ts` explícitas em imports relativos.
