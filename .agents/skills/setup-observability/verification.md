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

Generate every profile into a fresh temporary directory. Prove plan nonmutation, write, identical rerun, conflict atomicity, user-edit preservation, forbidden-output rejection, and secret exclusion. Install each profile in its own packed consumer with only its declared dependencies. Compile generated TypeScript and execute the generated local verification command for every profile. Executable profiles without application evidence must fail at that explicit owner prerequisite.

For NestJS, start a fresh package consumer and exercise its module lifecycle. For React, execute the generated browser composition and verify traces and selected metrics through the existing browser package tests.

Authorized local verification follows `../verify-observability/SKILL.md`. Do not run deployed canaries. Use recording process and Sentry transports to prove generated invocation, identity binding, cleanup, and failure propagation without credentials. Report unavailable provider read-back and deployed application transports as blocked.
