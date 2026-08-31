import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { compileManagedQuery, parseManagedQuery } from "../src/ManagedQuery.ts";

const parse = (query: string) => Effect.runPromise(parseManagedQuery(query));

describe("managed query", () => {
  test("parses a bounded query and compiles aliases from the AST", async () => {
    const query = await parse(
      'signal(logs) | where event.name == "payment.attempt" and event.outcome == "failure" | summarize count() by payment.provider, bin(event.timestamp, 5m)',
    );
    expect(query.binding.identifiers).toEqual(["payment.attempt"]);
    expect(
      compileManagedQuery(query, {
        dataset: "checkout-production-logs",
        language: "apl",
        signals: ["payment.attempt", "payment.charge"],
      }).text,
    ).toBe(
      "['checkout-production-logs'] | where ['event.name'] in ('payment.attempt', 'payment.charge') and ['event.outcome'] == 'failure' | summarize count() by ['payment.provider'], bin(['event.timestamp'], 5m)",
    );
  });

  test("rejects missing, duplicate, ambiguous and arbitrary provider predicates", async () => {
    for (const query of [
      "signal(logs) | summarize count()",
      'signal(logs) | where event.name == "a.b" or event.name == "c.d"',
      'signal(logs) | where event.name == "a.b" and event.name == "c.d"',
      'signal(logs) | where contains(event.name, "a.b")',
      'signal(logs) | where event.name == "a.b" | join other',
      'signal(logs) | where event.name == "a.b" // provider comment',
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(parseManagedQuery(query)))).toBe(true);
    }
  });

  test("keeps quoted comment and OR text while rejecting syntax outside strings", async () => {
    await parse(
      'signal(logs) | where event.name == "payment.attempt" and note == "x -- y" and category == "cats or dogs"',
    );
    for (const query of [
      'signal(logs) | where event.name == "payment.attempt" -- comment',
      'signal(logs) | where event.name == "payment.attempt" or note == "accepted"',
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(parseManagedQuery(query)))).toBe(true);
    }
  });

  test("renders decimal-stable quantiles and escapes APL literals", async () => {
    for (const [quantile, percentile] of [
      ["0.29", "29"],
      ["0.07", "7"],
      ["0.007", "0.7"],
      ["0.1234", "12.34"],
    ]) {
      const query = await parse(
        `signal(metrics) | where metric.name == "payment.latency" | summarize quantile(value, ${quantile})`,
      );
      expect(
        compileManagedQuery(query, {
          dataset: "metrics",
          language: "apl",
          signals: ["payment.latency"],
        }).text,
      ).toContain(`percentile(['value'], ${percentile})`);
    }
    const query = await parse(
      `signal(logs) | where event.name == "payment.attempt" and note == "quote' slash\\\\ newline\nnext"`,
    );
    expect(
      compileManagedQuery(query, {
        dataset: "logs",
        language: "apl",
        signals: ["payment.attempt"],
      }).text,
    ).toContain(String.raw`['note'] == 'quote\' slash\\ newline\nnext'`);
  });

  test("rejects oversized and unterminated input", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(parseManagedQuery("x".repeat(16_385))))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(parseManagedQuery('signal(logs) | where event.name == "a.b')),
      ),
    ).toBe(true);
  });
});
