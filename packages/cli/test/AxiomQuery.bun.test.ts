import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  compileAxiomQuery,
  fractionFromPercentile,
  type AxiomQueryTarget,
} from "../src/AxiomQuery.ts";
import { parseManagedQuery } from "../src/ManagedQuery.ts";

const compile = (text: string, target: AxiomQueryTarget) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const query = yield* parseManagedQuery(text);
      return yield* compileAxiomQuery(query, target);
    }),
  );

const compileError = (text: string, target: AxiomQueryTarget) =>
  Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const query = yield* parseManagedQuery(text);
        return yield* compileAxiomQuery(query, target);
      }),
    ),
  );

const metrics = (metricKind: "counter" | "histogram" | "observable_gauge", signal: string) =>
  ({
    language: "mpl",
    dataset: "checkout-production-metrics",
    signals: [signal],
    metricKind,
  }) satisfies AxiomQueryTarget;

describe("Axiom query compiler", () => {
  test("renders event queries against the OpenTelemetry attribute layout of logs datasets", async () => {
    const query = await compile(
      'signal(logs) | where event.name == "payment.attempt" and payment.provider in ("stripe", "adyen") and service.name == "checkout-api" | summarize count() by payment.provider, bin(timestamp, 5m)',
      { language: "apl", dataset: "checkout-production-logs", signals: ["payment.attempt"] },
    );
    expect(query).toEqual({
      language: "apl",
      dataset: "checkout-production-logs",
      text: [
        "['checkout-production-logs']",
        "| where ['attributes.event.name'] == 'payment.attempt' and ['attributes.payment.provider'] in ('stripe', 'adyen') and ['service.name'] == 'checkout-api'",
        "| summarize count() by ['attributes.payment.provider'], bin(_time, 5m)",
      ].join("\n"),
    });
  });

  test("expands aliased event signals and escapes APL literals", async () => {
    const query = await compile(
      'signal(logs) | where event.name == "payment.attempt" and payment.provider == "it\'s" | summarize count()',
      {
        language: "apl",
        dataset: "checkout-production-logs",
        signals: ["payment.attempt", "payment.charge"],
      },
    );
    expect(query.text).toBe(
      "['checkout-production-logs']\n| where ['attributes.event.name'] in ('payment.attempt', 'payment.charge') and ['attributes.payment.provider'] == 'it\\'s'\n| summarize count()",
    );
  });

  test("renders cumulative counters, histograms and gauges as MPL pipelines", async () => {
    const counter = await compile(
      'signal(metrics) | where metric.name == "payment.count" and payment.result in ("failed", "timeout") | summarize sum(value) by payment.provider',
      metrics("counter", "payment.count"),
    );
    expect(counter.text).toBe(
      [
        "`checkout-production-metrics`:`payment.count`",
        '| where (`payment.result` == "failed" or `payment.result` == "timeout")',
        "| map increase",
        "| align using sum",
        "| group by `payment.provider` using sum",
      ].join("\n"),
    );
    const histogram = await compile(
      'signal(metrics) | where metric.name == "payment.latency" | summarize quantile(value, 0.95) by bin(timestamp, 5m)',
      metrics("histogram", "payment.latency"),
    );
    expect(histogram.text).toBe(
      "`checkout-production-metrics`:`payment.latency`\n| bucket using interpolate_cumulative_histogram(rate, 0.95)",
    );
    const gauge = await compile(
      'signal(metrics) | where metric.name == "queue.depth" and queue.state == "ready" | summarize max(value)',
      metrics("observable_gauge", "queue.depth"),
    );
    expect(gauge.text).toBe(
      '`checkout-production-metrics`:`queue.depth`\n| where `queue.state` == "ready"\n| align using max\n| group using max',
    );
  });

  test("converts percentiles to fractions without floating point drift", () => {
    expect(fractionFromPercentile("95")).toBe("0.95");
    expect(fractionFromPercentile("99.9")).toBe("0.999");
    expect(fractionFromPercentile("100")).toBe("1");
    expect(fractionFromPercentile("5")).toBe("0.05");
    expect(fractionFromPercentile("0.5")).toBe("0.005");
  });

  test("rejects shapes that Axiom cannot evaluate faithfully", async () => {
    const cases: ReadonlyArray<readonly [string, AxiomQueryTarget]> = [
      [
        'signal(traces) | where event.name == "payment.attempt" | summarize count()',
        { language: "apl", dataset: "checkout-production-traces", signals: ["payment.attempt"] },
      ],
      [
        'signal(logs) | where event.name == "payment.attempt" | summarize count() by bin(payment.provider, 5m)',
        { language: "apl", dataset: "checkout-production-logs", signals: ["payment.attempt"] },
      ],
      [
        'signal(metrics) | where metric.name == "payment.latency" | summarize avg(value)',
        metrics("histogram", "payment.latency"),
      ],
      [
        'signal(metrics) | where metric.name == "payment.count" | summarize count()',
        metrics("counter", "payment.count"),
      ],
      [
        'signal(metrics) | where metric.name == "payment.count" | summarize sum(value)',
        {
          language: "mpl",
          dataset: "checkout-production-metrics",
          signals: ["payment.count", "payment.count_v2"],
          metricKind: "counter",
        },
      ],
      [
        'signal(metrics) | where metric.name == "payment.count"',
        metrics("counter", "payment.count"),
      ],
    ];
    for (const [text, target] of cases) {
      const error = await compileError(text, target);
      expect(error.code).toBe("OBS_CLI_QUERY_INVALID");
    }
  });
});
