# @equipe-tech/observability-sentry

Adaptadores de captura de defeitos inesperados para Sentry.

Use `@equipe-tech/observability-sentry/node` com o ciclo de vida Node e `@equipe-tech/observability-sentry/browser` no cliente. Ambos aplicam a mesma politica de dados antes do envio. O pacote nao ativa tracing, replay, breadcrumbs, sessoes ou coleta de PII.

O entrypoint raiz exporta `sentrySourceMapUpload`, que produz os argumentos de `sentry-cli sourcemaps upload` sem incluir credenciais. Passe o token ao processo por `SENTRY_AUTH_TOKEN`.
