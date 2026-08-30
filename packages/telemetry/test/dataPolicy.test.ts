import { assert, describe, it } from "vite-plus/test";
import { Effect, Option } from "effect";
import { CorrelationContext } from "../src/Correlation.ts";
import {
  baseDataPolicy,
  definePolicy,
  parseDataPolicy,
  type PolicySurface,
} from "../src/policy/DataPolicy.ts";
import { sanitizeDefectEnvelope } from "../src/policy/DefectEnvelope.ts";
import { metricLabelRejection } from "../src/policy/MetricLabelPolicy.ts";
import { sanitizeText, transformSignalFields } from "../src/policy/PolicyTransform.ts";

const marker = (): string => crypto.randomUUID().replaceAll("-", "");

const applicationPolicy = definePolicy({
  attributes: {
    "customer.tier": { classification: "public", required: false, metricLabel: true },
    "customer.email": { classification: "sensitive", required: false, metricLabel: false },
    "payment.card": { classification: "forbidden", required: false, metricLabel: false },
  },
  blockedKeys: ["application[._]secret"],
  blockedValuePatterns: ["provider_[A-Za-z0-9]+"],
});

const compile = () => Effect.runPromise(parseDataPolicy(applicationPolicy));

describe("executable data policy discrimination", () => {
  it("removes authorization secrets before log fields reach the Collector", async () => {
    const secret = marker();
    const decision = transformSignalFields(await compile(), "log", {
      "http.authorization": `Bearer ${secret}`,
      "cart.total": 12,
    });
    assert.notInclude(JSON.stringify(decision.value), secret);
    assert.strictEqual(decision.value["cart.total"], 12);
  });

  it("keeps copied retry-buffer fields free of application secrets", async () => {
    const secret = marker();
    const first = transformSignalFields(await compile(), "log", {
      "request.detail": `provider_${secret}`,
    });
    const retained = structuredClone(first.value);
    assert.notInclude(JSON.stringify(retained), secret);
  });

  it("rejects authorization values before recording metric labels", () => {
    const secret = marker();
    assert.strictEqual(
      metricLabelRejection(baseDataPolicy, "http.authorization", `Bearer ${secret}`),
      "attribute-name",
    );
  });

  it("rejects UUID-shaped metric label values", () => {
    assert.strictEqual(
      metricLabelRejection(baseDataPolicy, "worker.name", "123e4567-e89b-12d3-a456-426614174000"),
      "identifier-shape",
    );
  });

  it("keeps built-in sensitive classifications when extensions omit them", async () => {
    const policy = await Effect.runPromise(
      parseDataPolicy({
        attributes: {
          "http.authorization": {
            classification: "public",
            required: false,
            metricLabel: false,
          },
        },
        blockedKeys: [],
        blockedValuePatterns: [],
      }),
    );
    assert.strictEqual(policy.classify("http.authorization"), "sensitive");
  });

  it("rejects policy extensions that loosen contract classifications", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        parseDataPolicy(
          {
            attributes: {
              "customer.email": {
                classification: "internal",
                required: false,
                metricLabel: false,
              },
            },
            blockedKeys: [],
            blockedValuePatterns: [],
          },
          {
            "customer.email": {
              classification: "sensitive",
              required: false,
              metricLabel: false,
            },
          },
        ),
      ),
    );
    assert.strictEqual(failure.issues[0]?.code, "OBS_POLICY_CONTRACT_CONFLICT");
  });

  it("masks sensitive event fields", async () => {
    const decision = transformSignalFields(await compile(), "event", {
      "customer.email": "person@example.com",
    });
    assert.strictEqual(decision.value["customer.email"], "****");
  });

  it("drops forbidden event fields and reports the drop", async () => {
    const decision = transformSignalFields(await compile(), "event", {
      "payment.card": "4111111111111111",
    });
    assert.isUndefined(decision.value["payment.card"]);
    assert.strictEqual(decision.dropped, 1);
  });

  it("produces the same fields when sanitized twice", async () => {
    const policy = await compile();
    const secret = marker();
    const first = transformSignalFields(policy, "log", {
      "request.detail": `Bearer ${secret}`,
    });
    const second = transformSignalFields(policy, "log", first.value);
    assert.deepStrictEqual(second.value, first.value);
  });

  it("redacts a JWT assigned to a password field", async () => {
    const secret = marker();
    assert.strictEqual(
      sanitizeText(await compile(), `password=eyJ${secret}.eyJ${secret}.${secret}`),
      `password=[REDACTED]`,
    );
  });

  it("omits invalid blocked patterns from policy errors", async () => {
    const secret = marker();
    const failure = await Effect.runPromise(
      Effect.flip(
        parseDataPolicy({
          attributes: {},
          blockedKeys: [],
          blockedValuePatterns: [`[${secret}`],
        }),
      ),
    );
    assert.notInclude(JSON.stringify(failure), secret);
  });

  it("uses a blocked-key-specific unsafe pattern code", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        parseDataPolicy({
          attributes: {},
          blockedKeys: ["(a+)+"],
          blockedValuePatterns: [],
        }),
      ),
    );
    assert.strictEqual(failure.issues[0]?.code, "OBS_POLICY_UNSAFE_BLOCKED_KEY_PATTERN");
  });

  it("removes bearer secrets from error text", async () => {
    const secret = marker();
    assert.notInclude(sanitizeText(await compile(), `Error: Bearer ${secret}`), secret);
  });

  it("truncates server text without replacing useful output", async () => {
    const policy = await compile();
    const decision = transformSignalFields(policy, "log", {
      "request.detail": "x".repeat(40_000),
    });
    assert.strictEqual(String(decision.value["request.detail"]).length, 32_768);
    assert.deepInclude(decision.redactions, {
      rule: "bounds",
      action: "truncated",
      surface: "log",
    });
  });

  it("preserves request and run correlation identifiers", async () => {
    const decision = transformSignalFields(await compile(), "log", {
      "request.id": "request-123",
      "run.id": "test-canary-123",
    });
    assert.deepStrictEqual(decision.value, {
      "request.id": "request-123",
      "run.id": "test-canary-123",
    });
  });

  it("leaves words containing sensitive substrings unchanged", async () => {
    const policy = await compile();
    for (const value of ["tokenizer", "documentation", "secretive", "decade", "facade"]) {
      assert.strictEqual(sanitizeText(policy, value), value);
    }
  });

  it("sanitizes repeated application secrets before any signal buffer", async () => {
    const policy = await compile();
    const secret = marker();
    const surfaces: ReadonlyArray<Exclude<PolicySurface, "metric">> = [
      "event",
      "log",
      "span",
      "browser-ingest",
      "defect",
      "resource",
    ];
    for (const surface of surfaces) {
      const decision = transformSignalFields(policy, surface, {
        "request.detail": `provider_${secret} provider_${secret}`,
      });
      assert.notInclude(JSON.stringify(decision.value), secret);
      assert.strictEqual(decision.redactions[0]?.rule, "blocked-value");
    }
    assert.strictEqual(
      sanitizeText(policy, `provider_${secret} provider_${secret}`),
      "[REDACTED] [REDACTED]",
    );
  });

  it("redacts repeated structured assignments on every server signal", async () => {
    const policy = await compile();
    const source =
      "password=first password=second authorization: alpha authorization: beta cookie=one cookie=two";
    const expected =
      "password=[REDACTED] password=[REDACTED] authorization: [REDACTED] authorization: [REDACTED] cookie=[REDACTED] cookie=[REDACTED]";
    const surfaces: ReadonlyArray<Exclude<PolicySurface, "browser-ingest" | "metric">> = [
      "log",
      "span",
      "resource",
      "event",
      "defect",
    ];
    for (const surface of surfaces) {
      const decision = transformSignalFields(policy, surface, { "request.detail": source });
      assert.strictEqual(decision.value["request.detail"], expected);
      assert.deepInclude(decision.redactions, {
        rule: "blocked-value",
        action: "masked",
        surface,
      });
    }
    const textSurfaces: ReadonlyArray<"log" | "span" | "event" | "defect"> = [
      "log",
      "span",
      "event",
      "defect",
    ];
    for (const surface of textSurfaces) {
      assert.strictEqual(sanitizeText(policy, source, surface), expected);
    }
  });

  it("removes repeated raw Bearer assignments from every text and field surface", async () => {
    const policy = await compile();
    const secret = marker();
    const source = `authorization: Bearer ${secret} authorization: Bearer ${secret}`;
    const surfaces: ReadonlyArray<Exclude<PolicySurface, "metric">> = [
      "event",
      "log",
      "span",
      "browser-ingest",
      "defect",
      "resource",
    ];
    for (const surface of surfaces) {
      const decision = transformSignalFields(policy, surface, { "request.detail": source });
      assert.notInclude(JSON.stringify(decision.value), secret);
      assert.strictEqual(
        decision.value["request.detail"],
        "authorization: [REDACTED] authorization: [REDACTED]",
      );
    }
    const textSurfaces: ReadonlyArray<"event" | "log" | "span" | "defect"> = [
      "event",
      "log",
      "span",
      "defect",
    ];
    for (const surface of textSurfaces) {
      const body = sanitizeText(policy, source, surface);
      assert.notInclude(body, secret);
      assert.strictEqual(body, "authorization: [REDACTED] authorization: [REDACTED]");
    }
  });

  it("reports exact browser masking and truncation records", async () => {
    const policy = await compile();
    const secret = marker();
    const masked = transformSignalFields(policy, "browser-ingest", {
      "request.detail": `provider_${secret} provider_${secret}`,
    });
    assert.deepStrictEqual(masked.redactions, [
      { rule: "blocked-value", action: "masked", surface: "browser-ingest" },
    ]);
    const longKey = `field.${"a".repeat(130)}`;
    const truncatedKey = transformSignalFields(policy, "browser-ingest", { [longKey]: "kept" });
    assert.deepStrictEqual(truncatedKey.redactions, [
      { rule: "bounds", action: "truncated", surface: "browser-ingest" },
    ]);
    const truncatedText = transformSignalFields(policy, "browser-ingest", {
      "field.value": "x".repeat(2_000),
    });
    assert.deepStrictEqual(truncatedText.redactions, [
      { rule: "bounds", action: "truncated", surface: "browser-ingest" },
    ]);
  });

  it("counts browser policy and bounds drops exactly", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field.value${index}`, String(index)]),
    );
    fields["payment.card"] = "4111111111111111";
    const decision = transformSignalFields(await compile(), "browser-ingest", fields);
    assert.strictEqual(decision.dropped, 9);
    assert.strictEqual(Object.keys(decision.value).length, 32);
  });

  it("emits every public policy rule and action", async () => {
    const policy = await compile();
    const fields = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`field.value${index}`, index]),
    );
    const decisions = [
      transformSignalFields(policy, "event", { "Bad Key": "value" }),
      transformSignalFields(policy, "event", { "application.secret": "value" }),
      transformSignalFields(policy, "event", { "request.detail": "provider_SECRET" }),
      transformSignalFields(policy, "event", { "customer.email": "person@example.com" }),
      transformSignalFields(policy, "event", { "request.detail": "x".repeat(20_000) }),
      transformSignalFields(policy, "event", fields),
    ];
    const rules = new Set(
      decisions.flatMap((decision) => decision.redactions.map((entry) => entry.rule)),
    );
    const actions = new Set(
      decisions.flatMap((decision) => decision.redactions.map((entry) => entry.action)),
    );
    assert.deepStrictEqual([...rules].sort(), [
      "attribute-name",
      "blocked-key",
      "blocked-value",
      "bounds",
      "classification",
    ]);
    assert.deepStrictEqual([...actions].sort(), ["dropped", "masked", "truncated"]);
  });

  it("rejects numeric identifier labels but keeps stable numeric labels", () => {
    assert.strictEqual(
      metricLabelRejection(baseDataPolicy, "worker.name", 987654321012),
      "identifier-shape",
    );
    assert.isUndefined(metricLabelRejection(baseDataPolicy, "http.status_code", 200));
  });

  it("rejects blocked values before they become metric series identity", () => {
    const secret = marker();
    assert.isDefined(metricLabelRejection(baseDataPolicy, "request.secret", `provider_${secret}`));
  });

  it("rejects masked metric label values", () => {
    assert.isDefined(metricLabelRejection(baseDataPolicy, "safe.label", "****"));
    assert.isDefined(metricLabelRejection(baseDataPolicy, "safe.label", "[REDACTED]"));
  });

  it("returns none for a forbidden defect envelope", async () => {
    const envelope = sanitizeDefectEnvelope(await compile(), {
      errorType: "UnexpectedDefect",
      errorMessage: "failure",
      stack: Option.none(),
      fingerprint: [],
      tags: new Map(),
      context: new Map([["payment.card", "4111111111111111"]]),
      correlation: new CorrelationContext({}),
    });
    assert.isTrue(Option.isNone(envelope.value));
  });

  it("preserves partial defects after malformed keys and bounds drops", async () => {
    const context = new Map<string, string>([["Bad Key", "dropped"]]);
    for (let index = 0; index < 200; index += 1) {
      context.set(`context.field${index}`, String(index));
    }
    const envelope = sanitizeDefectEnvelope(await compile(), {
      errorType: "UnexpectedDefect",
      errorMessage: "failure",
      stack: Option.none(),
      fingerprint: [],
      tags: new Map(),
      context,
      correlation: new CorrelationContext({}),
    });
    const value = Option.getOrThrow(envelope.value);
    assert.strictEqual(value.context.size, 128);
    assert.strictEqual(envelope.dropped, 73);
    assert.deepInclude(envelope.redactions, {
      rule: "attribute-name",
      action: "dropped",
      surface: "defect",
    });
    assert.deepInclude(envelope.redactions, {
      rule: "bounds",
      action: "dropped",
      surface: "defect",
    });
  });

  it("bounds two hundred defect tags as one map", async () => {
    const tags = new Map(
      Array.from({ length: 200 }, (_, index) => [`tag.field${index}`, String(index)]),
    );
    const envelope = sanitizeDefectEnvelope(await compile(), {
      errorType: "UnexpectedDefect",
      errorMessage: "failure",
      stack: Option.none(),
      fingerprint: [],
      tags,
      context: new Map(),
      correlation: new CorrelationContext({}),
    });
    const value = Option.getOrThrow(envelope.value);
    assert.strictEqual(value.tags.size, 128);
    assert.strictEqual(envelope.dropped, 72);
    assert.strictEqual(value.tags.get("tag.field0"), "0");
    assert.strictEqual(value.tags.get("tag.field127"), "127");
    assert.isFalse(value.tags.has("tag.field128"));
  });

  it("preserves bounded defect stacks", async () => {
    const stack = `Error: failure\n${"at function (file.ts:1:1)\n".repeat(3_000)}`;
    const envelope = sanitizeDefectEnvelope(await compile(), {
      errorType: "UnexpectedDefect",
      errorMessage: "failure",
      stack: Option.some(stack),
      fingerprint: [],
      tags: new Map(),
      context: new Map(),
      correlation: new CorrelationContext({}),
    });
    const sanitized = Option.getOrThrow(Option.getOrThrow(envelope.value).stack);
    assert.strictEqual(sanitized.length, 65_536);
    assert.include(sanitized, "Error: failure");
  });

  it("sanitizes the destination-neutral defect envelope", async () => {
    const secret = marker();
    const envelope = sanitizeDefectEnvelope(await compile(), {
      errorType: "UnexpectedDefect",
      errorMessage: `Bearer ${secret}`,
      stack: Option.some(`provider_${secret}`),
      fingerprint: [`provider_${secret}`],
      tags: new Map([["release.name", "1.0.0"]]),
      context: new Map([["customer.email", `${secret}@example.com`]]),
      correlation: new CorrelationContext({}),
    });
    assert.notInclude(JSON.stringify(Option.getOrThrow(envelope.value)), secret);
  });
});
