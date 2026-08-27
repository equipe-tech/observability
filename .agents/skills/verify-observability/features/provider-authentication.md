# Provider authentication

The CLI validates Axiom and Sentry administrator credentials and stores them in isolated local state.

## Sub-features

- `auth-axiom` validates an Axiom personal access token.
- `auth-sentry` validates a Sentry organization token.
- `auth-storage` writes the credential file with owner-only permissions.
- `auth-status` validates both stored credentials again.

## How to get to it (user POV)

- Run `observability auth login axiom --organization-id <id>`.
- Enter the token at `Axiom personal access token`.
- Run `observability auth login sentry --organization <slug> --team <slug>`.
- Enter the token at `Sentry organization auth token`.
- Run `observability auth status`.

## Driving it with verify-observability

Preconditions:

- Use dedicated verification credentials for both providers.
- Export `AXIOM_ORGANIZATION_ID`, `SENTRY_ORGANIZATION`, and `SENTRY_TEAM`.
- The parent skill created a fresh `STATE_ROOT`.
- Use a PTY that protects secret input.

- **Start Axiom login.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" auth login axiom --organization-id "$AXIOM_ORGANIZATION_ID"` in the PTY.
- **Enter the Axiom token.** Wait for the exact protected prompt. Send the token through the host secret-input facility.
- **Verify Axiom.** Require exit code `0` and `Authenticated with Axiom as <identity>.` Do not save the typed token.
- **Start Sentry login.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" auth login sentry --organization "$SENTRY_ORGANIZATION" --team "$SENTRY_TEAM"` in the PTY.
- **Enter the Sentry token.** Wait for the exact protected prompt. Send the token through the host secret-input facility.
- **Verify Sentry.** Require exit code `0` and `Authenticated with Sentry organization <identity>.` Do not save the typed token.
- **Verify the file.** Locate `credentials.json` under `STATE_ROOT`. Require file mode `0600` and parent mode `0700`.
- **Verify status.** Run `OBSERVABILITY_HOME="$STATE_ROOT" bun "$CLI" auth status`. Require both identities and the isolated credential path.
- **Capture proof.** Save redacted transcripts, exit codes, identities, path, and permission modes.

## Gotchas

- Never pass provider tokens as command arguments.
- Never store provider tokens in evidence.
- The login commands call live provider APIs.
- A copied credential file is not proof of valid authentication.
- Cleanup removes the isolated local credentials but does not revoke provider tokens.
