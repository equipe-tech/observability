# Browser telemetry data policy

`BrowserTelemetry.emit` accepts event names and scalar fields. Field values remain limited to strings, finite numbers, and booleans. The wire batch remains version 1 and uses the same scalar contract.

## Sink boundary

Sanitization runs before a `BrowserEvent` is constructed and before the event enters the in-memory queue. An empty sanitized event name becomes the bounded name `browser.event`, so queued events always satisfy the wire schema. Recording transports, retry batches, periodic flushes, finalizers, and fetch transports therefore receive only the sanitized representation.

`BrowserTelemetry` has no console sink. This policy does not cover application-owned console calls and does not add console interception.

## Unsupported runtime values

JavaScript callers can bypass TypeScript declarations. Objects, arrays, null, undefined, functions, symbols, big integers, non-finite numbers, deep values, wide values, and cycles are dropped as complete fields. They are not traversed, stringified, logged, or retained. Valid scalar siblings remain available.

## Sensitive fields

Sensitive key terms include authorization, proxy authorization, cookies, passwords, secrets, tokens, API keys, access keys, client secrets, private keys, email, phone, CPF, CNPJ, and document identifiers. Matching is case-insensitive, recognizes dot, underscore, hyphen, camel-case, digit, and end-of-key boundaries, and can start within a longer key. Negative words such as `tokenizer`, `documentation`, and `secretive` do not match.

The original complete key is inspected before bounding. A scalar value under a sensitive key becomes `****`. A key containing credential text or a structured sensitive assignment is removed.

## Sensitive text

The following content becomes `[REDACTED]` within safe string values and event names:

- Bearer authorization values
- `sk_`, `sk-`, `rk_`, and `rk-` credentials
- JSON Web Tokens
- Email addresses
- RSA, EC, OpenSSH, and generic private-key blocks
- Sensitive `key=value` and `key:value` assignments anywhere in the text, including query strings, form data, bracketed keys such as `data[password]`, quoted values, Basic and Digest credentials, cookies, and values containing spaces

The scanner searches for sensitive assignments instead of consuming each outer assignment as a unit. An ampersand, URL fragment marker, or matching quote ends a redacted value and preserves the remaining text. When no delimiter is unambiguous, sanitization replaces the rest of the bounded string. This intentional loss prevents a credential with spaces, a Digest field, or a cookie field from escaping through an uncertain boundary. JavaScript and Collector patterns treat ASCII whitespace and the common Unicode spaces U+00A0, U+1680, U+2000 through U+200A, U+202F, U+205F, and U+3000 as whitespace.

Valid serialized JSON beginning with an object or array is parsed and sanitized iteratively. Values under sensitive property keys become `[REDACTED]`, credential-bearing keys disappear, credential patterns and structured sensitive assignments are replaced in string leaves, array order is retained, and compact valid JSON is emitted. Traversal is limited to 32 levels and 1,024 values. Inputs beyond either limit become `[REDACTED]`.

Malformed JSON-like text containing a sensitive term becomes `[REDACTED]`. Browser structured-text handling is intentionally stricter than the Collector policy because the browser can parse a bounded JSON string before queue insertion.

## Bounds and collisions

Sanitization inspects complete original input before applying output bounds.

| Data               | Original inspection bound |            Output bound |
| ------------------ | ------------------------: | ----------------------: |
| Field key          |   2,048 UTF-16 code units |   128 UTF-16 code units |
| String field value |  16,384 UTF-16 code units | 1,024 UTF-16 code units |
| Event name         |  16,384 UTF-16 code units |   128 UTF-16 code units |
| Fields per event   |            Not applicable |  32 unique bounded keys |
| Events per batch   |            Not applicable |                      64 |
| Event identifier   |            Not applicable |    64 UTF-16 code units |

Oversized original keys are dropped. Oversized original string values and event names become `[REDACTED]`. If different original keys produce the same bounded key, the first accepted field in JavaScript iteration order wins. Later fields do not replace or merge with it.

## Collector parity

The telemetry package owns the semantic key vocabulary and the five core credential patterns. A repository parity test checks both Collector assets against that vocabulary, processor coverage, and processor order. Traces, logs, and metrics run the same redaction transform before the sensitive-key processor. Metric resource attributes and datapoint attributes therefore receive the same structured-assignment redaction as log and trace attributes. Browser JSON traversal is intentionally outside exact Collector parity because Collector OTTL does not expose the same recursive contract.
