import { assert, describe, it } from "vite-plus/test";
import { Predicate, Schema } from "effect";
import { createServer, type Server } from "node:http";
import { createMetrics, MetricsError, type MetricAttribute } from "../src/Metrics.ts";

const AttributeValue = Schema.Struct({
  stringValue: Schema.String.pipe(Schema.optionalKey),
  boolValue: Schema.Boolean.pipe(Schema.optionalKey),
  intValue: Schema.Number.pipe(Schema.optionalKey),
  doubleValue: Schema.Number.pipe(Schema.optionalKey),
});
const Attribute = Schema.Struct({ key: Schema.String, value: AttributeValue });
const NumberPoint = Schema.Struct({
  attributes: Schema.Array(Attribute),
  asDouble: Schema.Number.pipe(Schema.optionalKey),
  asInt: Schema.Number.pipe(Schema.optionalKey),
});
const HistogramPoint = Schema.Struct({
  attributes: Schema.Array(Attribute),
  count: Schema.Number,
  sum: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  explicitBounds: Schema.Array(Schema.Number),
  bucketCounts: Schema.Array(Schema.Number),
});
const ExportedMetric = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  unit: Schema.String,
  sum: Schema.Struct({
    aggregationTemporality: Schema.Number,
    isMonotonic: Schema.Boolean,
    dataPoints: Schema.Array(NumberPoint),
  }).pipe(Schema.optionalKey),
  gauge: Schema.Struct({ dataPoints: Schema.Array(NumberPoint) }).pipe(Schema.optionalKey),
  histogram: Schema.Struct({
    aggregationTemporality: Schema.Number,
    dataPoints: Schema.Array(HistogramPoint),
  }).pipe(Schema.optionalKey),
});
const MetricsPayload = Schema.Struct({
  resourceMetrics: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({ attributes: Schema.Array(Attribute) }),
      scopeMetrics: Schema.Array(
        Schema.Struct({
          scope: Schema.Struct({ name: Schema.String }),
          metrics: Schema.Array(ExportedMetric),
        }),
      ),
    }),
  ),
});
const decodeMetricsPayload = Schema.decodeUnknownSync(MetricsPayload);
type CapturedPayload = typeof MetricsPayload.Type;

interface StubControl {
  status: number;
  delayMilliseconds: number;
}

interface StubCollector {
  readonly endpoint: string;
  readonly requests: Array<CapturedPayload>;
  readonly control: StubControl;
  readonly server: Server;
}

const startCollector = (): Promise<StubCollector> =>
  new Promise((resolve, reject) => {
    const requests: Array<CapturedPayload> = [];
    const control: StubControl = { status: 200, delayMilliseconds: 0 };
    const server = createServer((request, response) => {
      const chunks: Array<Uint8Array> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("error", reject);
      request.on("end", () => {
        try {
          requests.push(decodeMetricsPayload(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          setTimeout(() => {
            response.writeHead(control.status, { "content-type": "application/json" });
            response.end("{}");
          }, control.delayMilliseconds);
        } catch (cause) {
          reject(cause);
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || Predicate.isString(address)) {
        reject(new Error("Collector did not bind to a TCP address."));
        return;
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        requests,
        control,
        server,
      });
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
      } else {
        reject(cause);
      }
    });
  });

const metricsFrom = (payload: CapturedPayload): ReadonlyArray<typeof ExportedMetric.Type> =>
  payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];

const metricNamed = (
  payload: CapturedPayload,
  name: string,
): typeof ExportedMetric.Type | undefined =>
  metricsFrom(payload).find((metric) => metric.name === name);

const errorCode = (operation: () => void): string | undefined => {
  try {
    operation();
    return undefined;
  } catch (cause) {
    return cause instanceof MetricsError ? cause.code : undefined;
  }
};

const asyncErrorCode = async (operation: () => Promise<void>): Promise<string | undefined> => {
  try {
    await operation();
    return undefined;
  } catch (cause) {
    return cause instanceof MetricsError ? cause.code : undefined;
  }
};

const options = (endpoint: string, flushTimeoutMilliseconds = 1_000) => ({
  serviceName: "metrics-test",
  serviceVersion: "1.2.3",
  environment: "test",
  otlpEndpoint: endpoint,
  exportIntervalMilliseconds: 60_000,
  flushTimeoutMilliseconds,
});

describe("framework-neutral metrics", () => {
  it("exports counter, histogram, and immediately collected gauge values through real OTLP", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      const counter = metrics.counter({
        name: "orders.created",
        description: "Created orders",
        unit: "1",
      });
      const histogram = metrics.histogram({
        name: "orders.duration",
        description: "Order duration",
        unit: "ms",
        boundaries: [10, 20],
      });
      let gaugeValue = 3;
      const gauge = metrics.observableGauge(
        {
          name: "workers.load",
          description: "Worker load",
          unit: "%",
        },
        () => [
          { value: gaugeValue, attributes: [{ key: "worker", value: "alpha" }] },
          { value: gaugeValue + 1, attributes: [{ key: "worker", value: "beta" }] },
        ],
      );
      counter.add(2, [{ key: "region", value: "south" }]);
      histogram.record(12, [{ key: "region", value: "south" }]);

      assert.deepEqual(await metrics.flush(), { gaugeFailures: [] });
      gaugeValue = 8;
      assert.deepEqual(await metrics.flush(), { gaugeFailures: [] });

      const first = collector.requests[0];
      const second = collector.requests[1];
      assert.isDefined(first);
      assert.isDefined(second);
      const counterExport = metricNamed(first, "orders.created");
      const histogramExport = metricNamed(first, "orders.duration");
      const gaugeExport = metricNamed(first, "workers.load");
      assert.equal(counterExport?.sum?.isMonotonic, true);
      assert.equal(counterExport?.sum?.dataPoints[0]?.asDouble, 2);
      assert.equal(histogramExport?.unit, "ms");
      assert.deepEqual(histogramExport?.histogram?.dataPoints[0]?.explicitBounds, [10, 20]);
      assert.deepEqual(histogramExport?.histogram?.dataPoints[0]?.bucketCounts, [0, 1, 0]);
      assert.equal(histogramExport?.histogram?.dataPoints[0]?.count, 1);
      assert.equal(histogramExport?.histogram?.dataPoints[0]?.sum, 12);
      assert.equal(gaugeExport?.unit, "%");
      assert.deepEqual(
        gaugeExport?.gauge?.dataPoints.map((point) => point.asDouble),
        [3, 4],
      );
      assert.deepEqual(
        metricNamed(second, "workers.load")?.gauge?.dataPoints.map((point) => point.asDouble),
        [8, 9],
      );
      for (const metric of metricsFrom(first)) {
        for (const point of [
          ...(metric.sum?.dataPoints ?? []),
          ...(metric.gauge?.dataPoints ?? []),
          ...(metric.histogram?.dataPoints ?? []),
        ]) {
          assert.notInclude(
            point.attributes.map((attribute) => attribute.key),
            "unit",
          );
          assert.notInclude(
            point.attributes.map((attribute) => attribute.key),
            "time_unit",
          );
        }
      }

      gauge.unregister();
      await metrics.flush();
      const afterUnregister = collector.requests[2];
      assert.isDefined(afterUnregister);
      assert.isUndefined(metricNamed(afterUnregister, "workers.load"));
      await metrics.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("isolates gauge callback failures and performs final close collection exactly once", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      let goodValue = 1;
      let goodCalls = 0;
      let failedCalls = 0;
      metrics.counter({ name: "alive.total", description: "Alive", unit: "1" }).add(1);
      metrics.observableGauge({ name: "good.gauge", description: "Good gauge", unit: "1" }, () => {
        goodCalls++;
        return [{ value: goodValue }];
      });
      metrics.observableGauge(
        { name: "failed.gauge", description: "Failed gauge", unit: "1" },
        () => {
          failedCalls++;
          throw new Error("callback defect");
        },
      );

      const first = await metrics.flush();
      assert.deepEqual(
        first.gaugeFailures.map((failure) => failure.code),
        ["CALLBACK_FAILED"],
      );
      const firstPayload = collector.requests[0];
      assert.isDefined(firstPayload);
      assert.isDefined(metricNamed(firstPayload, "alive.total"));
      assert.isDefined(metricNamed(firstPayload, "good.gauge"));
      assert.isUndefined(metricNamed(firstPayload, "failed.gauge"));

      goodValue = 7;
      const closePromise = metrics.close();
      assert.strictEqual(metrics.close(), closePromise);
      const final = await closePromise;
      assert.deepEqual(
        final.gaugeFailures.map((failure) => failure.code),
        ["CALLBACK_FAILED"],
      );
      const finalPayload = collector.requests[1];
      assert.isDefined(finalPayload);
      assert.equal(metricNamed(finalPayload, "good.gauge")?.gauge?.dataPoints[0]?.asDouble, 7);
      const settledCalls = [goodCalls, failedCalls];
      const settledRequests = collector.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual([goodCalls, failedCalls], settledCalls);
      assert.equal(collector.requests.length, settledRequests);
      assert.equal(
        errorCode(() => metrics.flush()),
        "CLOSED",
      );
    } finally {
      await closeServer(collector.server);
    }
  });

  it("rejects incompatible definitions and invalid measurements before mutation", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      const counter = metrics.counter({
        name: "bounded.counter",
        description: "Bounded counter",
        unit: "1",
      });
      assert.equal(
        errorCode(() =>
          metrics.histogram({
            name: "bounded.counter",
            description: "Bounded counter",
            unit: "1",
            boundaries: [1],
          }),
        ),
        "INSTRUMENT_CONFLICT",
      );
      assert.equal(
        errorCode(() => counter.add(-1)),
        "INVALID_MEASUREMENT",
      );
      assert.equal(
        errorCode(() => counter.add(Number.NaN)),
        "INVALID_MEASUREMENT",
      );
      assert.equal(
        errorCode(() =>
          counter.add(
            1,
            Array.from({ length: 17 }, (_, index): MetricAttribute => ({
              key: `attribute.${index}`,
              value: index,
            })),
          ),
        ),
        "LIMIT_EXCEEDED",
      );
      assert.equal(
        errorCode(() =>
          metrics.counter({ name: "invalid name", description: "Invalid", unit: "1" }),
        ),
        "INVALID_INSTRUMENT",
      );
      assert.equal(collector.requests.length, 0);
      await metrics.close();
      const closePayload = collector.requests[0];
      assert.isDefined(closePayload);
      assert.deepEqual(
        metricsFrom(closePayload).map((metric) => metric.name),
        ["bounded.counter"],
      );
      assert.equal(metricNamed(closePayload, "bounded.counter")?.sum?.dataPoints.length, 0);
    } finally {
      await closeServer(collector.server);
    }
  });

  it("shares compatible instruments and enforces lifetime series limits", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      const keeper = await createMetrics(options(collector.endpoint));
      const first = metrics.counter({
        name: "cardinality.total",
        description: "Cardinality total",
        unit: "1",
      });
      const second = metrics.counter({
        name: "cardinality.total",
        description: "Cardinality total",
        unit: "1",
      });
      first.add(1, [{ key: "series", value: 0 }]);
      second.add(2, [{ key: "series", value: 0 }]);
      for (let index = 1; index < 1_000; index++) {
        first.add(1, [{ key: "series", value: index }]);
      }
      assert.equal(
        errorCode(() => first.add(1, [{ key: "series", value: 1_000 }])),
        "LIMIT_EXCEEDED",
      );
      await metrics.flush();
      const payload = collector.requests[0];
      assert.isDefined(payload);
      const exported = metricNamed(payload, "cardinality.total");
      assert.equal(exported?.sum?.dataPoints.length, 1_000);
      assert.equal(exported?.sum?.dataPoints[0]?.asDouble, 3);
      await metrics.close();
      const afterClose = keeper.counter({
        name: "cardinality.total",
        description: "Cardinality total",
        unit: "1",
      });
      afterClose.add(1, [{ key: "series", value: 999 }]);
      assert.equal(
        errorCode(() => afterClose.add(1, [{ key: "series", value: 1_000 }])),
        "LIMIT_EXCEEDED",
      );
      await keeper.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("reports invalid gauge batches without suppressing other instruments", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      metrics.counter({ name: "valid.total", description: "Valid total", unit: "1" }).add(1);
      metrics.observableGauge(
        { name: "bounded.gauge", description: "Bounded gauge", unit: "1" },
        () => [
          {
            value: 1,
            attributes: Array.from({ length: 17 }, (_, index): MetricAttribute => ({
              key: `attribute.${index}`,
              value: index,
            })),
          },
        ],
      );
      const result = await metrics.flush();
      assert.deepEqual(
        result.gaugeFailures.map((failure) => failure.code),
        ["ATTRIBUTE_LIMIT_EXCEEDED"],
      );
      const payload = collector.requests[0];
      assert.isDefined(payload);
      assert.isDefined(metricNamed(payload, "valid.total"));
      assert.isUndefined(metricNamed(payload, "bounded.gauge"));
      await metrics.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("surfaces transport failure and timeout through typed errors", async () => {
    const collector = await startCollector();
    try {
      const failed = await createMetrics(options(collector.endpoint));
      failed.counter({ name: "failed.total", description: "Failed", unit: "1" }).add(1);
      collector.control.status = 503;
      assert.equal(
        await asyncErrorCode(async () => {
          await failed.flush();
        }),
        "EXPORT_FAILED",
      );
      collector.control.status = 200;
      await failed.close();

      const timed = await createMetrics(options(collector.endpoint, 20));
      timed.counter({ name: "timed.total", description: "Timed", unit: "1" }).add(1);
      collector.control.delayMilliseconds = 200;
      assert.equal(
        await asyncErrorCode(async () => {
          await timed.flush();
        }),
        "FLUSH_TIMED_OUT",
      );
      assert.equal(
        await asyncErrorCode(async () => {
          await timed.close();
        }),
        "FLUSH_TIMED_OUT",
      );
      collector.control.delayMilliseconds = 0;
    } finally {
      await closeServer(collector.server);
    }
  });

  it("keeps disabled mode inert while retaining validation", async () => {
    const collector = await startCollector();
    try {
      let callbackCalls = 0;
      const metrics = await createMetrics({ ...options(collector.endpoint), enabled: false });
      const counter = metrics.counter({
        name: "disabled.counter",
        description: "Disabled counter",
        unit: "1",
      });
      const histogram = metrics.histogram({
        name: "disabled.histogram",
        description: "Disabled histogram",
        unit: "ms",
        boundaries: [1, 2],
      });
      const gauge = metrics.observableGauge(
        { name: "disabled.gauge", description: "Disabled gauge", unit: "1" },
        () => {
          callbackCalls++;
          return [{ value: 1 }];
        },
      );
      counter.add(1, [{ key: "safe", value: true }]);
      histogram.record(1.5);
      gauge.unregister();
      assert.deepEqual(await metrics.flush(), { gaugeFailures: [] });
      assert.deepEqual(await metrics.close(), { gaugeFailures: [] });
      assert.equal(callbackCalls, 0);
      assert.equal(collector.requests.length, 0);
      assert.equal(
        errorCode(() => counter.add(1)),
        "CLOSED",
      );
    } finally {
      await closeServer(collector.server);
    }
  });
});
