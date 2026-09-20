import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { destinationObservedRun } from "../src/node/LocalCollector.ts";
import type {
  CapturedLog,
  CapturedMetric,
  CapturedSpan,
  CapturedTelemetry,
} from "../src/testing/index.ts";

const runId = "job-fixture-1";
const traceId = "0af7651916cd43dd8448eb211c80319c";

const attributes = (entries: ReadonlyArray<readonly [string, string]>) => new Map(entries);

const span = (spanId: string, parentSpanId: Option.Option<string>): CapturedSpan => ({
  traceId,
  spanId,
  parentSpanId,
  name: "span",
  kind: 1,
  statusCode: 0,
  statusMessage: Option.none(),
  attributes: attributes([]),
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  links: [],
  droppedLinksCount: 0,
  eventNames: [],
  linkedSpanIds: [],
  resourceAttributes: attributes([]),
});

const log = (spanId: Option.Option<string>): CapturedLog => ({
  traceId: Option.map(spanId, () => traceId),
  spanId,
  severityText: Option.some("INFO"),
  droppedAttributesCount: 0,
  body: Option.none(),
  attributes: attributes([
    ["run.id", runId],
    ["event.name", "item.read"],
  ]),
  resourceAttributes: attributes([]),
});

const metric = (value: string): CapturedMetric => ({
  kind: "sum",
  isMonotonic: true,
  aggregationTemporality: 2,
  name: "item.reads",
  description: "",
  unit: "1",
  points: [{ value: Option.some(1), attributes: attributes([["fixture.run_id", value]]) }],
  resourceAttributes: attributes([]),
});

const telemetry = (input: Partial<CapturedTelemetry>): CapturedTelemetry => ({
  spans: [],
  logs: [],
  metrics: [],
  ...input,
});

describe("destinationObservedRun", () => {
  it("requires current-run logs before any other signal", () => {
    expect(destinationObservedRun(telemetry({}), runId, {})).toBe(false);
    expect(destinationObservedRun(telemetry({ logs: [log(Option.none())] }), runId, {})).toBe(true);
  });

  it("waits for the linked span and its parent when traces are selected", () => {
    const logs = [log(Option.some("child"))];
    expect(destinationObservedRun(telemetry({ logs }), runId, { traces: true })).toBe(false);
    expect(
      destinationObservedRun(
        telemetry({ logs, spans: [span("child", Option.some("root"))] }),
        runId,
        {
          traces: true,
        },
      ),
    ).toBe(false);
    expect(
      destinationObservedRun(
        telemetry({
          logs,
          spans: [span("root", Option.none()), span("child", Option.some("root"))],
        }),
        runId,
        { traces: true },
      ),
    ).toBe(true);
  });

  it("waits for a metric point tagged with the current run", () => {
    const logs = [log(Option.none())];
    const options = { metricRunIdAttribute: "fixture.run_id" };
    expect(destinationObservedRun(telemetry({ logs }), runId, options)).toBe(false);
    expect(
      destinationObservedRun(telemetry({ logs, metrics: [metric("other-run")] }), runId, options),
    ).toBe(false);
    expect(
      destinationObservedRun(telemetry({ logs, metrics: [metric(runId)] }), runId, options),
    ).toBe(true);
  });

  it("honors a custom event run attribute", () => {
    const custom: CapturedLog = {
      ...log(Option.none()),
      attributes: attributes([["fixture.run_id", runId]]),
    };
    expect(destinationObservedRun(telemetry({ logs: [custom] }), runId, {})).toBe(false);
    expect(
      destinationObservedRun(telemetry({ logs: [custom] }), runId, {
        eventRunIdAttribute: "fixture.run_id",
      }),
    ).toBe(true);
  });
});
