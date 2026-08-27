import { assert, describe, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  isSensitiveFieldKey,
  sanitizeBrowserEventName,
  sanitizeBrowserFields,
  sensitiveFieldReplacement,
  sensitiveTextReplacement,
} from "../src/RedactionPolicy.ts";
import type { WideEventFields } from "../src/WideEvent.ts";

const SanitizedJson = Schema.fromJsonString(
  Schema.Struct({
    profile: Schema.Struct({
      email: Schema.String,
      display: Schema.String,
      escaped: Schema.String,
      assignment: Schema.String,
      ordinary: Schema.String,
    }),
    events: Schema.Array(Schema.Struct({ token: Schema.String, note: Schema.String })),
  }),
);
const decodeSanitizedJson = Schema.decodeUnknownSync(SanitizedJson);

const marker = (): string => crypto.randomUUID().replaceAll("-", "");

interface RuntimeNode {
  self?: RuntimeNode;
  child?: RuntimeNode;
}

const runtimeFields = (): WideEventFields => {
  const fields: WideEventFields = { valid: "kept" };
  const cyclic: RuntimeNode = {};
  cyclic.self = cyclic;
  let deep: RuntimeNode = {};
  for (let index = 0; index < 100; index += 1) {
    deep = { child: deep };
  }
  const wide = Object.fromEntries(
    Array.from({ length: 2_000 }, (_, index) => [`key${index}`, index]),
  );
  const invalid = {
    object: { nested: true },
    array: ["value"],
    null: null,
    undefined,
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    bigint: BigInt(1),
    symbol: Symbol("value"),
    function: () => "value",
    deep,
    wide,
    cyclic,
  };
  for (const [key, value] of Object.entries(invalid)) {
    Object.defineProperty(fields, key, { value, enumerable: true });
  }
  return fields;
};

describe("browser telemetry redaction policy", () => {
  it("classifies the complete sensitive vocabulary and keeps negative controls", () => {
    const terms = [
      ["authorization"],
      ["proxy", "authorization"],
      ["cookie"],
      ["set", "cookie"],
      ["password"],
      ["passwd"],
      ["secret"],
      ["token"],
      ["api", "key"],
      ["apikey"],
      ["access", "key"],
      ["client", "secret"],
      ["private", "key"],
      ["email"],
      ["phone"],
      ["cpf"],
      ["cnpj"],
      ["document"],
    ];
    for (const segments of terms) {
      const compact = segments.join("");
      const camel = segments
        .map((segment, index) =>
          index === 0 ? segment : `${segment[0]?.toUpperCase()}${segment.slice(1)}`,
        )
        .join("");
      for (const key of [
        compact,
        compact.toUpperCase(),
        segments.join("."),
        segments.join("_"),
        segments.join("-"),
        camel,
        `prefix.${compact}`,
        `${compact}2`,
      ]) {
        assert.isTrue(isSensitiveFieldKey(key));
      }
    }
    for (const key of ["tokenizer", "documentation", "secretive", "phoneme", "documentary"]) {
      assert.isFalse(isSensitiveFieldKey(key));
    }
  });

  it("masks sensitive scalar fields and embedded credential patterns", () => {
    const secret = marker();
    const fields = sanitizeBrowserFields({
      authorization: secret,
      phone2: 5511999999999,
      "private-key": true,
      bearer: `before Bearer ${secret} after`,
      service: `sk_${secret}`,
      jwt: `eyJ${secret}.eyJ${secret}.${secret}`,
      contact: `${secret}@example.com`,
      pem: `-----BEGIN PRIVATE KEY-----${secret}-----END PRIVATE KEY-----`,
      control: "tokenizer documentation secretive phoneme documentary",
    });
    assert.strictEqual(fields.authorization, sensitiveFieldReplacement);
    assert.strictEqual(fields.phone2, sensitiveFieldReplacement);
    assert.strictEqual(fields["private-key"], sensitiveFieldReplacement);
    assert.notInclude(JSON.stringify(fields), secret);
    assert.include(String(fields.bearer), sensitiveTextReplacement);
    assert.include(String(fields.service), sensitiveTextReplacement);
    assert.include(String(fields.jwt), sensitiveTextReplacement);
    assert.include(String(fields.contact), sensitiveTextReplacement);
    assert.include(String(fields.pem), sensitiveTextReplacement);
    assert.strictEqual(fields.control, "tokenizer documentation secretive phoneme documentary");
  });

  it("sanitizes structured JSON, assignments, escaped strings, and malformed JSON", () => {
    const secret = marker();
    const json = JSON.stringify({
      profile: {
        email: secret,
        display: `Bearer ${secret}`,
        escaped: `quoted "Bearer ${secret}"`,
        assignment: `authorization=${secret}`,
        ordinary: "authorization guide",
      },
      events: [
        { token: secret, note: `password:${secret}` },
        { token: secret, note: "ordinary value" },
      ],
    });
    const fields = sanitizeBrowserFields({
      json,
      assignments: `authorization = "${secret}" other:value token:'${secret}'`,
      malformed: `{"token":"${secret}"`,
      escaped: `password="escaped\\"${secret}"`,
    });
    const decoded = decodeSanitizedJson(fields.json);
    assert.strictEqual(decoded.profile.email, sensitiveTextReplacement);
    assert.strictEqual(decoded.profile.escaped, `quoted "${sensitiveTextReplacement}"`);
    assert.strictEqual(decoded.profile.assignment, `authorization=${sensitiveTextReplacement}`);
    assert.strictEqual(decoded.profile.ordinary, "authorization guide");
    assert.strictEqual(decoded.events[0]?.note, `password:${sensitiveTextReplacement}`);
    assert.strictEqual(decoded.events[1]?.note, "ordinary value");
    assert.strictEqual(decoded.events[0]?.token, sensitiveTextReplacement);
    assert.strictEqual(decoded.events[1]?.token, sensitiveTextReplacement);
    assert.notInclude(JSON.stringify(fields), secret);
    assert.strictEqual(fields.malformed, sensitiveTextReplacement);
    assert.include(String(fields.assignments), `authorization = "${sensitiveTextReplacement}"`);
    assert.include(String(fields.escaped), sensitiveTextReplacement);
  });

  it("fails closed for excessive JSON depth, value count, and original string size", () => {
    let deep = '"safe"';
    for (let index = 0; index < 34; index += 1) {
      deep = `{"safe":${deep}}`;
    }
    const wide = JSON.stringify(Array.from({ length: 1_025 }, (_, index) => index));
    const boundedJson = JSON.stringify({ safe: "x".repeat(2_000) });
    const fields = sanitizeBrowserFields({
      deep,
      wide,
      boundedJson,
      oversized: "x".repeat(16_385),
    });
    assert.strictEqual(fields.deep, sensitiveTextReplacement);
    assert.strictEqual(fields.wide, sensitiveTextReplacement);
    assert.strictEqual(fields.boundedJson, sensitiveTextReplacement);
    assert.strictEqual(fields.oversized, sensitiveTextReplacement);
  });

  it("drops every unsupported runtime value while retaining valid siblings", () => {
    const fields = sanitizeBrowserFields(runtimeFields());
    assert.deepStrictEqual(fields, { valid: "kept" });
  });

  it("preserves inherited names and proto as safe own fields", () => {
    const names = ["toString", "constructor", "hasOwnProperty", "__proto__"];
    const input = Object.fromEntries(names.map((name) => [name, `value-${name}`]));
    const fields = sanitizeBrowserFields(input);
    assert.strictEqual(Object.getPrototypeOf(fields), Object.prototype);
    assert.deepStrictEqual(Object.keys(fields), names);
    for (const name of names) {
      assert.isTrue(Object.prototype.hasOwnProperty.call(fields, name));
      assert.strictEqual(fields[name], `value-${name}`);
    }
  });

  it("preserves proto and inherited names in sanitized JSON text", () => {
    const names = ["toString", "constructor", "hasOwnProperty", "__proto__"];
    const source = Object.fromEntries(names.map((name) => [name, `value-${name}`]));
    const fields = sanitizeBrowserFields({ json: JSON.stringify(source) });
    const serialized = String(fields.json);
    for (const name of names) {
      assert.include(serialized, `"${name}":"value-${name}"`);
    }
    assert.strictEqual(serialized, JSON.stringify(source));
  });

  it("inspects complete keys and values before applying output bounds", () => {
    const secret = marker();
    const dangerousKey = `${"x".repeat(140)}.authorization`;
    const credentialKey = `header.Bearer ${secret}`;
    const oversizedKey = "z".repeat(2_049);
    const fields = sanitizeBrowserFields({
      [dangerousKey]: secret,
      [credentialKey]: "value",
      [oversizedKey]: "value",
      boundary: `${"x".repeat(1_020)} Bearer ${secret}`,
    });
    assert.strictEqual(fields[dangerousKey.slice(0, 128)], sensitiveFieldReplacement);
    assert.isUndefined(fields[credentialKey.slice(0, 128)]);
    assert.isUndefined(fields[oversizedKey.slice(0, 128)]);
    assert.notInclude(JSON.stringify(fields), secret);
    assert.strictEqual(String(fields.boundary).length, 1_024);
  });

  it("uses first bounded key wins for safe and sensitive collisions", () => {
    const prefix = "x".repeat(128);
    const safeFirst = sanitizeBrowserFields({
      [`${prefix}.safe`]: "first",
      [`${prefix}.token`]: "second",
    });
    const sensitiveFirst = sanitizeBrowserFields({
      [`${prefix}.token`]: "first",
      [`${prefix}.safe`]: "second",
    });
    assert.strictEqual(safeFirst[prefix], "first");
    assert.strictEqual(sensitiveFirst[prefix], sensitiveFieldReplacement);
    assert.deepStrictEqual(Object.keys(safeFirst), [prefix]);
    assert.deepStrictEqual(Object.keys(sensitiveFirst), [prefix]);
    assert.isTrue(Object.prototype.hasOwnProperty.call(safeFirst, prefix));
    assert.isTrue(Object.prototype.hasOwnProperty.call(sensitiveFirst, prefix));
  });

  it("sanitizes event names before truncation", () => {
    const secret = marker();
    const eventName = sanitizeBrowserEventName(`checkout token=${secret} Bearer ${secret}`);
    assert.notInclude(eventName, secret);
    assert.include(eventName, sensitiveTextReplacement);
    assert.strictEqual(sanitizeBrowserEventName("x".repeat(16_385)), sensitiveTextReplacement);
  });
});
