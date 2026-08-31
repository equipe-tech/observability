import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  compileManagedQuery,
  ManagedQueryError,
  parseManagedQuery,
  type ManagedQuery,
} from "../src/ManagedQuery.ts";

const parse = (query: string) => Effect.runPromise(parseManagedQuery(query));
const compile = (query: ManagedQuery, target: Parameters<typeof compileManagedQuery>[1]) =>
  Effect.runPromise(compileManagedQuery(query, target));

describe("managed query", () => {
  test("parses a bounded query and compiles aliases from the AST", async () => {
    const query = await parse(
      'signal(logs) | where event.name == "payment.attempt" and event.outcome == "failure" | summarize count() by payment.provider, bin(event.timestamp, 5m)',
    );
    expect(query.binding.identifiers).toEqual(["payment.attempt"]);
    expect(
      (
        await compile(query, {
          dataset: "checkout-production-logs",
          language: "apl",
          signals: ["payment.attempt", "payment.charge"],
        })
      ).text,
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

  test("tokenizes case-insensitive boolean separators outside strings", async () => {
    for (const separator of [" AND ", "\tAnD\t", "\nand\n"]) {
      const query = await parse(
        `signal(logs) | where event.name == "payment.attempt"${separator}note == "x AND y"`,
      );
      expect(query.stages[0]?.kind === "where" ? query.stages[0].comparisons : []).toHaveLength(2);
    }
  });

  test("keeps quoted comments and OR text while rejecting syntax outside strings", async () => {
    await parse(
      'signal(logs) | where event.name == "payment.attempt" and note == "x -- y // z /* q */" and category == "cats OR dogs"',
    );
    for (const query of [
      'signal(logs) | where event.name == "payment.attempt" -- comment',
      'signal(logs) | where event.name == "payment.attempt" // comment',
      'signal(logs) | where event.name == "payment.attempt" /* comment */',
      'signal(logs) | where event.name == "payment.attempt" OR note == "accepted"',
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(parseManagedQuery(query)))).toBe(true);
    }
  });

  test("rejects interior quotes, trailing predicates, malformed escapes and unterminated strings", async () => {
    for (const literal of ['"x" undeclared == "y"', '"x""', '"x\\n"', '"x\\"', '"x']) {
      const exit = await Effect.runPromiseExit(
        parseManagedQuery(
          `signal(logs) | where event.name == "payment.attempt" and note == ${literal}`,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
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
        (
          await compile(query, {
            dataset: "metrics",
            language: "apl",
            signals: ["payment.latency"],
          })
        ).text,
      ).toContain(`percentile(['value'], ${percentile})`);
    }
    const query = await parse(
      `signal(logs) | where event.name == "payment.attempt" and note == "quote' slash\\\\ newline\nnext"`,
    );
    expect(
      (
        await compile(query, {
          dataset: "logs",
          language: "apl",
          signals: ["payment.attempt"],
        })
      ).text,
    ).toContain(String.raw`['note'] == 'quote\' slash\\ newline\nnext'`);
  });

  test("rejects unsafe numeric representations", async () => {
    for (const text of ["1e3", "0.0000001", "1000000000000000000000"]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            parseManagedQuery(
              `signal(logs) | where event.name == "payment.attempt" and value == ${text}`,
            ),
          ),
        ),
      ).toBe(true);
    }
    const query = await parse(
      'signal(logs) | where event.name == "payment.attempt" and value == 1',
    );
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e-7,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const unsafe: ManagedQuery = {
        ...query,
        stages: query.stages.map((stage) =>
          stage.kind === "where"
            ? {
                ...stage,
                comparisons: stage.comparisons.map((comparison) =>
                  comparison.field === "value"
                    ? { ...comparison, values: [{ kind: "number", value }] }
                    : comparison,
                ),
              }
            : stage,
        ),
      };
      const exit = await Effect.runPromiseExit(
        compileManagedQuery(unsafe, {
          dataset: "logs",
          language: "apl",
          signals: ["payment.attempt"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("escapes datasets and signals and rejects executable AST text", async () => {
    const query = await parse('signal(logs) | where event.name == "payment.attempt"');
    expect(
      (
        await compile(query, {
          dataset: "logs'] | take 1 | ['x",
          language: "apl",
          signals: ["payment' | take 1"],
        })
      ).text,
    ).toBe(String.raw`['logs\'] | take 1 | [\'x'] | where ['event.name'] == 'payment\' | take 1'`);

    const comparisonField: ManagedQuery = {
      ...query,
      stages: [
        {
          kind: "where",
          comparisons: [
            {
              kind: "comparison",
              field: "event.name'] | take 1 | ['x",
              operator: "==",
              values: [{ kind: "string", value: "payment.attempt" }],
            },
          ],
        },
      ],
    };
    const aggregationField: ManagedQuery = {
      ...query,
      stages: [
        ...query.stages,
        {
          kind: "summarize",
          aggregation: {
            kind: "field",
            function: "sum",
            field: "value'] | take 1 | ['x",
          },
          groups: [],
        },
      ],
    };
    const groupDuration: ManagedQuery = {
      ...query,
      stages: [
        ...query.stages,
        {
          kind: "summarize",
          aggregation: { kind: "count" },
          groups: [{ kind: "bin", field: "timestamp", duration: "5m) | take 1" }],
        },
      ],
    };
    const percentile: ManagedQuery = {
      ...query,
      stages: [
        ...query.stages,
        {
          kind: "summarize",
          aggregation: {
            kind: "quantile",
            field: "value",
            percentile: "95) | take 1",
          },
          groups: [],
        },
      ],
    };
    for (const unsafe of [comparisonField, aggregationField, groupDuration, percentile]) {
      const exit = await Effect.runPromiseExit(
        compileManagedQuery(unsafe, {
          dataset: "logs",
          language: "apl",
          signals: ["payment.attempt"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("fails typed when hand-built bindings or targets violate the compiler contract", async () => {
    const query = await parse('signal(logs) | where event.name == "payment.attempt"');
    const invalidBindings: ReadonlyArray<ManagedQuery> = [
      {
        ...query,
        stages: [
          {
            kind: "where",
            comparisons: [
              {
                kind: "comparison",
                field: "event.name",
                operator: "!=",
                values: [{ kind: "string", value: "payment.attempt" }],
              },
            ],
          },
        ],
      },
      { ...query, binding: { field: "event.name", identifiers: ["payment.other"] } },
      { ...query, binding: { field: "metric.name", identifiers: ["payment.attempt"] } },
    ];
    for (const invalid of invalidBindings) {
      const error = await Effect.runPromise(
        Effect.flip(
          compileManagedQuery(invalid, {
            dataset: "logs",
            language: "apl",
            signals: ["payment.attempt"],
          }),
        ),
      );
      expect(error).toBeInstanceOf(ManagedQueryError);
      expect(error.code).toBe("OBS_CLI_QUERY_INVALID");
    }
    const targetError = await Effect.runPromise(
      Effect.flip(
        compileManagedQuery(query, {
          dataset: "",
          language: "apl",
          signals: [""],
        }),
      ),
    );
    expect(targetError).toBeInstanceOf(ManagedQueryError);
    expect(targetError.code).toBe("OBS_CLI_QUERY_INVALID");
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
