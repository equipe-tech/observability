import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { ObservedDashboard, ObservedMonitor } from "../src/AxiomOperationsApi.ts";
import {
  describesMarker,
  observedDashboardFingerprint,
  observedMonitorFingerprint,
} from "../src/AxiomResources.ts";

const providerQueryOptions = {
  aggChartOpts: "{}",
  containsTimeFilter: "false",
  datasets: "[]",
  editorContent: "",
  endTime: "",
  quickRange: "",
  resultsHistogram: "",
  selection: "",
  shownColumns: "",
  startTime: "",
};

const dashboard = (queryOptions: { readonly [key: string]: string }) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(ObservedDashboard)({
      uid: "checkout-prod-payments",
      version: "3",
      dashboard: {
        name: "Payments (prod)",
        owner: "X-AXIOM-EVERYONE",
        description: "observability-managed:checkout/prod/payments",
        charts: [
          {
            id: "attempts",
            name: "Attempts",
            type: "TimeSeries",
            datasetId: "checkout-prod-logs",
            query: { apl: "['checkout-prod-logs'] | count", queryOptions },
          },
        ],
        layout: [{ i: "attempts", x: 0, y: 0, w: 6, h: 4 }],
        refreshTime: 300,
        schemaVersion: 2,
        timeWindowStart: "qr-now-24h",
        timeWindowEnd: "qr-now",
      },
    }),
  );

describe("Axiom resource projections", () => {
  test("ignores only captured provider defaults in chart query options", () => {
    const empty = observedDashboardFingerprint(dashboard({}));
    expect(observedDashboardFingerprint(dashboard(providerQueryOptions))).toBe(empty);
    expect(
      observedDashboardFingerprint(dashboard({ ...providerQueryOptions, editorContent: "false" })),
    ).not.toBe(empty);
    expect(
      observedDashboardFingerprint(dashboard({ ...providerQueryOptions, quickRange: "qr-now-7d" })),
    ).not.toBe(empty);
    expect(
      observedDashboardFingerprint(dashboard({ ...providerQueryOptions, unknownOption: "" })),
    ).not.toBe(empty);
  });

  test("treats omitted provider booleans as false and reads MPL from aplQuery", () => {
    const decode = Schema.decodeUnknownSync(ObservedMonitor);
    const providerResponse = {
      id: "monitor-1",
      name: "Payment failures (prod)",
      description: "Payment failures\nobservability-managed:checkout/prod/payment-failures",
      type: "Threshold",
      operator: "AboveOrEqual",
      threshold: 5,
      intervalMinutes: 5,
      rangeMinutes: 10,
      notifierIds: ["notifier"],
      resolvable: true,
      triggerAfterNPositiveResults: 1,
      triggerFromNRuns: 1,
      aplQuery: "`checkout-prod-metrics`:`payment.count`\n| map increase",
    };
    const omitted = decode(providerResponse);
    const explicit = decode({
      ...providerResponse,
      alertOnNoData: false,
      notifyByGroup: false,
      notifyEveryRun: false,
      aplQuery: "",
      mplQuery: "`checkout-prod-metrics`:`payment.count`\n| map increase",
    });
    expect(observedMonitorFingerprint(omitted)).toBe(observedMonitorFingerprint(explicit));
  });

  test("accepts the managed marker only as the final description line", () => {
    const marker = "observability-managed:checkout/prod/payments";
    expect(describesMarker(`Payments\n${marker}`, marker)).toBe(true);
    expect(describesMarker(`${marker}\nPayments`, marker)).toBe(false);
    expect(describesMarker(`${marker} `, marker)).toBe(false);
  });
});
