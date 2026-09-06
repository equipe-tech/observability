import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  compileManagedQuery,
  ManagedQueryError,
  parseManagedQuery,
  type ManagedQuery,
  type ManagedQueryComparison,
  type ManagedQueryLiteral,
  type ManagedQueryStage,
  type ManagedQueryTarget,
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

    const hazards =
      "\u0000\u001f\u007f\u0085\u009f\u00ad\u061c\u200e\u2028\u2029\u202e\u2066\ufeff\u{1bca0}\u{e0001}";
    const hazardousQuery: ManagedQuery = {
      ...query,
      stages: query.stages.map((stage) =>
        stage.kind === "where"
          ? {
              ...stage,
              comparisons: stage.comparisons.map((comparison) =>
                comparison.field === "note"
                  ? { ...comparison, values: [{ kind: "string", value: hazards }] }
                  : comparison,
              ),
            }
          : stage,
      ),
    };
    const rendered = (
      await compile(hazardousQuery, {
        dataset: "logs",
        language: "apl",
        signals: ["payment.attempt"],
      })
    ).text;
    expect(rendered).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(rendered).toContain(
      String.raw`\u0000\u001f\u007f\u0085\u009f\u00ad\u061c\u200e\u2028\u2029\u202e\u2066\ufeff\ud82f\udca0\udb40\udc01`,
    );
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

  test("returns typed failures for hostile getters, proxies and rendering defects", async () => {
    const query = await parse('signal(logs) | where event.name == "payment.attempt"');
    const hostileTarget: ManagedQueryTarget = {
      get dataset(): string {
        throw new Error("hostile dataset getter");
      },
      language: "apl",
      signals: ["payment.attempt"],
    };
    const hostileQuery = new Proxy(query, {
      ownKeys() {
        throw new Error("hostile query proxy");
      },
    });
    for (const effect of [
      compileManagedQuery(query, hostileTarget),
      compileManagedQuery(hostileQuery, {
        dataset: "logs",
        language: "apl",
        signals: ["payment.attempt"],
      }),
    ]) {
      const error = await Effect.runPromise(Effect.flip(effect));
      expect(error).toBeInstanceOf(ManagedQueryError);
      expect(error.code).toBe("OBS_CLI_QUERY_INVALID");
    }
  });

  test("bounds direct AST stages, comparisons, values and rendered text", async () => {
    const query = await parse('signal(logs) | where event.name == "payment.attempt"');
    const binding = query.stages[0];
    if (binding?.kind !== "where") throw new Error("Expected binding stage.");
    const comparison = binding.comparisons[0];
    if (comparison === undefined) throw new Error("Expected binding comparison.");
    const summary: ManagedQueryStage = {
      kind: "summarize",
      aggregation: { kind: "count" },
      groups: [],
    };
    const ordinaryComparison: ManagedQueryComparison = {
      kind: "comparison",
      field: "payment.provider",
      operator: "==",
      values: [{ kind: "string", value: "stripe" }],
    };
    const excessiveStages: ManagedQuery = {
      ...query,
      stages: [binding, ...Array.from({ length: 64 }, () => summary)],
    };
    const excessiveComparisons: ManagedQuery = {
      ...query,
      stages: [
        {
          kind: "where",
          comparisons: [comparison, ...Array.from({ length: 64 }, () => ordinaryComparison)],
        },
      ],
    };
    const excessiveValues: ManagedQuery = {
      ...query,
      stages: [
        binding,
        {
          kind: "where",
          comparisons: [
            {
              kind: "comparison",
              field: "payment.provider",
              operator: "in",
              values: Array.from({ length: 257 }, (_, index): ManagedQueryLiteral => ({
                kind: "string",
                value: `provider.${index}`,
              })),
            },
          ],
        },
      ],
    };
    const cases: ReadonlyArray<readonly [ManagedQuery, ManagedQueryTarget["signals"]]> = [
      [excessiveStages, ["payment.attempt"]],
      [excessiveComparisons, ["payment.attempt"]],
      [excessiveValues, ["payment.attempt"]],
      [query, ["x".repeat(16_384)]],
    ];
    for (const [candidate, signals] of cases) {
      const error = await Effect.runPromise(
        Effect.flip(
          compileManagedQuery(candidate, {
            dataset: "logs",
            language: "apl",
            signals,
          }),
        ),
      );
      expect(error).toBeInstanceOf(ManagedQueryError);
      expect(error.code).toBe("OBS_CLI_QUERY_INVALID");
    }
  });

  test("enforces identical parser and compiler query budgets", async () => {
    const binding = 'signal(logs) | where event.name == "payment.attempt"';
    const comparisons = Array.from({ length: 64 }, (_, index) => `field_${index} == ${index}`);
    const values = Array.from({ length: 257 }, (_, index) => `"signal.${index}"`);
    const groups = Array.from({ length: 65 }, (_, index) => `group_${index}`);
    const groupedStage = `summarize count() by ${Array.from({ length: 64 }, (_, index) => `group_${index}`).join(", ")}`;
    const rejected = [
      `${binding}${" | summarize count()".repeat(64)}`,
      `${binding} and ${comparisons.join(" and ")}`,
      `signal(logs) | where event.name in (${values.join(", ")})`,
      `${binding} | summarize count() by ${groups.join(", ")}`,
      `${binding} | where provider in (${values.slice(0, 256).join(", ")}) | where region in (${values.slice(0, 256).join(", ")})`,
      `${binding}${` | ${groupedStage}`.repeat(16)}`,
      `${binding} and note == "${"x".repeat(4_097)}"`,
      `${binding} and note == "${"\u0001".repeat(3_000)}"`,
      `signal(logs) | where event.name == "${"s".repeat(129)}"`,
      `${binding} and ${"field".repeat(26)} == 1`,
    ];
    for (const text of rejected) {
      const exit = await Effect.runPromiseExit(parseManagedQuery(text));
      expect(Exit.isFailure(exit)).toBeTrue();
    }

    const accepted = [
      `${binding}${" | summarize count()".repeat(63)}`,
      `${binding} and ${comparisons.slice(0, 63).join(" and ")}`,
      `signal(logs) | where event.name in (${values.slice(0, 256).join(", ")})`,
      `${binding} | summarize count() by ${groups.slice(0, 64).join(", ")}`,
    ];
    for (const text of accepted) {
      const query = await parse(text);
      const firstIdentifier = query.binding.identifiers[0];
      if (firstIdentifier === undefined) throw new Error("Expected a query binding.");
      const compiled = await compile(query, {
        dataset: "logs",
        language: "apl",
        signals: [firstIdentifier, ...query.binding.identifiers.slice(1)],
      });
      expect(compiled.text.length).toBeGreaterThan(0);
    }
  });

  test("rejects direct compiler inputs before oversized rendering work", async () => {
    const query = await parse('signal(logs) | where event.name == "payment.attempt"');
    const longField = `a${"a".repeat(128)}`;
    const longLiteral = "x".repeat(4_097);
    const directQueries: ReadonlyArray<ManagedQuery> = [
      {
        ...query,
        stages: [
          ...query.stages,
          {
            kind: "where",
            comparisons: [
              {
                kind: "comparison",
                field: longField,
                operator: "==",
                values: [{ kind: "string", value: "x" }],
              },
            ],
          },
        ],
      },
      {
        ...query,
        stages: [
          ...query.stages,
          {
            kind: "summarize",
            aggregation: { kind: "field", function: "sum", field: longField },
            groups: [],
          },
        ],
      },
      {
        ...query,
        stages: [
          ...query.stages,
          {
            kind: "summarize",
            aggregation: { kind: "count" },
            groups: [{ kind: "field", field: longField }],
          },
        ],
      },
      {
        ...query,
        stages: [
          ...query.stages,
          {
            kind: "where",
            comparisons: [
              {
                kind: "comparison",
                field: "note",
                operator: "==",
                values: [{ kind: "string", value: longLiteral }],
              },
            ],
          },
        ],
      },
      {
        ...query,
        stages: [
          ...query.stages,
          {
            kind: "where",
            comparisons: [
              {
                kind: "comparison",
                field: "note",
                operator: "==",
                values: [{ kind: "string", value: "\u0001".repeat(3_000) }],
              },
            ],
          },
        ],
      },
    ];
    const directInputs: ReadonlyArray<readonly [ManagedQuery, ManagedQueryTarget]> = [
      ...directQueries.map((candidate): readonly [ManagedQuery, ManagedQueryTarget] => [
        candidate,
        { dataset: "logs", language: "apl", signals: ["payment.attempt"] },
      ]),
      [query, { dataset: "d".repeat(256), language: "apl", signals: ["payment.attempt"] }],
      [query, { dataset: "logs", language: "apl", signals: ["s".repeat(129)] }],
      [
        query,
        { dataset: "d".repeat(1_000_000), language: "apl", signals: ["s".repeat(1_000_000)] },
      ],
    ];
    for (const [candidate, target] of directInputs) {
      const error = await Effect.runPromise(Effect.flip(compileManagedQuery(candidate, target)));
      expect(error).toBeInstanceOf(ManagedQueryError);
      expect(error.code).toBe("OBS_CLI_QUERY_INVALID");
    }
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
