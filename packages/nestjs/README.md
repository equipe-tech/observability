# @equipe-tech/observability-nestjs

Integração NestJS da plataforma de observabilidade da Equipe Tech.

Instale o núcleo, a integração, Effect e os peers do NestJS:

```sh
bun add @equipe-tech/observability @equipe-tech/observability-nestjs effect @nestjs/common @nestjs/core reflect-metadata rxjs
```

Importe o módulo, o interceptor, o controller de eventos do browser e a política de rotas pela raiz deste pacote:

```ts
import {
  createBrowserEventsController,
  TelemetryInterceptor,
  TelemetryModule,
} from "@equipe-tech/observability-nestjs";
```

O caminho antigo `@equipe-tech/observability/nestjs` não é exportado na linha 0.3.
