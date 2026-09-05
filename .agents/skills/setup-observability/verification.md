# Verification

Run from a pristine exact-head checkout.

```bash
VP_GIT_HOOKS=0 bun install --frozen-lockfile
bun run check
bun run test
bun run build
bun run compat
bun run test:package
bun run test:browser
```

Generate every profile into a fresh temporary directory. Prove plan nonmutation, write, identical rerun, conflict atomicity, user-edit preservation, forbidden-output rejection, and secret exclusion. Compile generated TypeScript against packed dependencies.

For NestJS, start a fresh package consumer and exercise its module lifecycle. For React, execute the generated browser composition and verify traces and selected metrics through the existing browser package tests.

Authorized local verification follows `../verify-observability/SKILL.md`. Do not run deployed canaries. Report provider read-back, published-route, and Sentry checks as blocked when credentials and deployed application transports are unavailable.
