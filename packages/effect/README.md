# @equipe-tech/observability-effect

Integração Effect nativa da plataforma de observabilidade da Equipe Tech.

Instale o núcleo, a integração e o Effect:

```sh
bun add @equipe-tech/observability @equipe-tech/observability-effect effect
```

Importe as Layers, o middleware HTTP, o limite de erros e a rota de eventos do browser pela raiz deste pacote:

```ts
import {
  defineErrorCatalog,
  effectEventsAdapter,
  errorBoundary,
  httpTelemetry,
  layerBrowserEventsRoute,
  layerObservability,
} from "@equipe-tech/observability-effect";
```

O pacote usa o perfil `effect-api` e compõe com `effect/unstable/http`. Consulte `docs/effect-http-semantics.md` no repositório para a semântica completa.
