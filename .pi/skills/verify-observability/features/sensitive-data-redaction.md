# Sensitive-data redaction

The local pipeline removes configured secret fields and secret values while it preserves unrelated control values.

## Sub-features

- `redaction-attributes` replaces sensitive attribute values with `****`.
- `redaction-bodies` replaces sensitive values in log bodies with `[REDACTED]`.
- `redaction-events` replaces sensitive values in span event names.
- `redaction-negative-controls` preserves words that only contain sensitive substrings.
- `redaction-signals` applies the policy to traces, logs, and metrics.

## How to get to it (user POV)

- Start the local stack with `observability dev up`.
- Run `OBSERVABILITY_E2E=1 bun run test:canary`.
- Inspect the isolated Collector export for redacted and preserved values.

## Driving it with verify-observability

Preconditions:

- The local stack passed the parent skill doctor check.
- The pipeline canary uses a fresh `STATE_ROOT`.
- `ARTIFACT_ROOT` exists.

- **Emit markers.** Run `OBSERVABILITY_HOME="$STATE_ROOT" OBSERVABILITY_E2E=1 bun run test:canary`. The canary creates unique sensitive markers for this run.
- **Verify blocked fields.** Require canary exit code `0`. The assertions cover authorization, password, access token, user password, and phone number attributes.
- **Verify blocked values.** Require canary exit code `0`. The assertions reject bearer tokens, secret-key patterns, email addresses, and serialized secret fields.
- **Verify output replacements.** Search the copied export for `****` and `[REDACTED]`. Both replacement forms exist.
- **Verify negative controls.** Require canary exit code `0`. The assertions preserve the generated `tokenizer` and `documentation` control values.
- **Capture proof.** Keep the canary output, isolated export, run ID, and replacement search output under `ARTIFACT_ROOT`.

## Gotchas

- Do not print the generated pre-redaction values outside the canary process.
- Do not use production credentials or production datasets.
- A visible replacement does not prove that every marker disappeared. Require the full canary result.
- A canary pass does not verify the deployed Collector configuration. Use the deployed canary only with dedicated E2E datasets.
