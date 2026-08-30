import { assert, describe, it } from "vite-plus/test";
import { Effect, ManagedRuntime, Metric, Option, Predicate, Schema } from "effect";
import { createServer, type Server } from "node:http";
import { createMetrics, MetricsError, type MetricAttribute } from "../src/Metrics.ts";
import { parseResourceIdentity } from "../src/ResourceIdentity.ts";
import { parseDataPolicy } from "../src/policy/DataPolicy.ts";
import * as Testing from "../src/testing/index.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";

const AttributeValue = Schema.Struct({
  stringValue: Schema.String.pipe(Schema.optionalKey),
  boolValue: Schema.Boolean.pipe(Schema.optionalKey),
  intValue: Schema.Number.pipe(Schema.optionalKey),
  doubleValue: Schema.Number.pipe(Schema.optionalKey),
});
const Attribute = Schema.Struct({ key: Schema.String, value: AttributeValue });
const NumberPoint = Schema.Struct({
  attributes: Schema.Array(Attribute),
  startTimeUnixNano: Schema.String,
  timeUnixNano: Schema.String,
  asDouble: Schema.Number.pipe(Schema.optionalKey),
  asInt: Schema.Number.pipe(Schema.optionalKey),
});
const HistogramPoint = Schema.Struct({
  attributes: Schema.Array(Attribute),
  startTimeUnixNano: Schema.String,
  timeUnixNano: Schema.String,
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

const waitFor = async (condition: () => boolean, timeoutMilliseconds = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition did not become true within ${timeoutMilliseconds} milliseconds.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("framework-neutral metrics", () => {
  it("applies the compiled application policy before metric state", async () => {
    const policy = await Effect.runPromise(
      parseDataPolicy({
        attributes: {},
        blockedKeys: ["customer[.]tier"],
        blockedValuePatterns: [],
      }),
    );
    const metrics = await createMetrics({
      enabled: false,
      serviceName: "policy-metrics",
      serviceVersion: "1.0.0",
      environment: "test",
      otlpEndpoint: "http://localhost:4318",
      policy,
    });
    const counter = metrics.counter({
      name: "policy.counter",
      description: "Policy counter",
      unit: "1",
    });
    let failure: MetricsError | undefined;
    try {
      counter.add(1, [{ key: "customer.tier", value: "gold" }]);
    } catch (cause) {
      if (cause instanceof MetricsError) failure = cause;
    }
    assert.strictEqual(failure?.code, "POLICY_BLOCKED");
    assert.strictEqual(failure?.policyReason, "classification");
    assert.isUndefined(failure?.attributeKey);
    await metrics.close();
  });

  it("reports every over-bound string label as a policy rejection", async () => {
    const metrics = await createMetrics({
      enabled: false,
      serviceName: "bounded-metrics",
      serviceVersion: "1.0.0",
      environment: "test",
      otlpEndpoint: "http://localhost:4318",
    });
    const counter = metrics.counter({
      name: "bounded.counter",
      description: "Bounded counter",
      unit: "1",
    });
    for (const length of [65, 256, 257]) {
      let failure: MetricsError | undefined;
      try {
        counter.add(1, [{ key: "worker.name", value: "x".repeat(length) }]);
      } catch (cause) {
        if (cause instanceof MetricsError) failure = cause;
      }
      assert.strictEqual(failure?.code, "POLICY_BLOCKED");
      assert.strictEqual(failure?.policyReason, "string-bound");
      assert.isUndefined(failure?.attributeKey);
    }
    await metrics.close();
  });

  it("uses canonical service resource identity and rejects the reserved instance datapoint key", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics({
        ...options(collector.endpoint),
        deploymentEnvironmentAlias: "emitted",
      });
      const counter = metrics.counter({
        name: "identity.total",
        description: "Identity total",
        unit: "1",
      });
      assert.equal(
        errorCode(() => counter.add(1, [{ key: "service.instance.id", value: "instance-1" }])),
        "INVALID_MEASUREMENT",
      );
      counter.add(1, [{ key: "run.id", value: "job-1" }]);
      await metrics.flush();
      const payload = collector.requests[0];
      assert.isDefined(payload);
      const resourceKeys =
        payload.resourceMetrics[0]?.resource.attributes.map((attribute) => attribute.key) ?? [];
      assert.include(resourceKeys, "service.namespace");
      assert.include(resourceKeys, "service.name");
      assert.include(resourceKeys, "service.version");
      assert.include(resourceKeys, "deployment.environment.name");
      assert.include(resourceKeys, "deployment.environment");
      assert.notInclude(resourceKeys, "service.instance.id");
      const pointKeys = metricNamed(payload, "identity.total")?.sum?.dataPoints[0]?.attributes.map(
        (attribute) => attribute.key,
      );
      assert.deepEqual(pointKeys, ["run.id"]);
      await metrics.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("rejects a non-HTTP OTLP endpoint with stable public configuration fields", async () => {
    const collector = await startCollector();
    try {
      let failure: MetricsError | undefined;
      try {
        await createMetrics({
          ...options(collector.endpoint),
          otlpEndpoint: "ftp://collector.invalid",
        });
      } catch (cause) {
        if (cause instanceof MetricsError) {
          failure = cause;
        }
      }
      assert.isDefined(failure);
      assert.equal(failure.name, "MetricsError");
      assert.equal(failure.code, "INVALID_CONFIGURATION");
      assert.equal(failure.operation, "createMetrics");
      assert.equal(failure.instrumentName, undefined);
      assert.isFalse(failure.retryable);
      assert.equal(failure.cause, undefined);
      assert.equal(
        failure.message,
        "Metrics configuration is invalid. Set otlpEndpoint to an HTTP or HTTPS URL without credentials.",
      );
      assert.equal(collector.requests.length, 0);
    } finally {
      await closeServer(collector.server);
    }
  });

  for (const fixture of [
    {
      field: "service.name",
      options: { serviceName: "Metrics_Test" },
      rule: "lowercase letters, numbers, and hyphens with at most 63 characters",
    },
    {
      field: "service.version",
      options: { serviceVersion: "latest" },
      rule: "SemVer 2.0.0 or a 7 to 64 character lowercase hexadecimal immutable release identifier",
    },
    {
      field: "deployment.environment.name",
      options: { environment: "Production" },
      rule: "lowercase letters, numbers, and hyphens with at most 32 characters",
    },
  ] satisfies ReadonlyArray<{
    readonly field: string;
    readonly options: {
      readonly serviceName?: string;
      readonly serviceVersion?: string;
      readonly environment?: string;
    };
    readonly rule: string;
  }>) {
    it(`reports the invalid createMetrics identity field ${fixture.field}`, async () => {
      let failure: MetricsError | undefined;
      try {
        await createMetrics({
          ...options("http://collector.invalid"),
          ...fixture.options,
        });
      } catch (cause) {
        if (cause instanceof MetricsError) {
          failure = cause;
        }
      }
      assert.isDefined(failure);
      assert.equal(failure.code, "INVALID_CONFIGURATION");
      assert.equal(failure.operation, "createMetrics");
      assert.equal(failure.field, fixture.field);
      assert.equal(failure.rule, fixture.rule);
      assert.include(failure.message, fixture.rule);
      assert.isFalse(failure.retryable);
    });
  }

  it("isolates a non-finite gauge observation and recovers on the next collection", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      let invalidValue = Number.NaN;
      let invalidCalls = 0;
      let validCalls = 0;
      metrics.counter({ name: "observation.total", description: "Total", unit: "1" }).add(1);
      metrics.observableGauge(
        { name: "observation.invalid", description: "Invalid observation", unit: "1" },
        () => {
          invalidCalls++;
          return [{ value: invalidValue }];
        },
      );
      metrics.observableGauge(
        { name: "observation.valid", description: "Valid observation", unit: "1" },
        () => {
          validCalls++;
          return [{ value: 7 }];
        },
      );

      const failed = await metrics.flush();
      const failure = failed.gaugeFailures[0];
      assert.isDefined(failure);
      assert.equal(failed.gaugeFailures.length, 1);
      assert.equal(failure.instrumentName, "observation.invalid");
      assert.equal(failure.code, "INVALID_OBSERVATION");
      assert.equal(
        failure.message,
        'Observable gauge "observation.invalid" produced a non-finite observation.',
      );
      assert.isFalse(Object.hasOwn(failure, "retryable"));
      const failedPayload = collector.requests[0];
      assert.isDefined(failedPayload);
      assert.isDefined(metricNamed(failedPayload, "observation.total"));
      assert.isDefined(metricNamed(failedPayload, "observation.valid"));
      assert.isUndefined(metricNamed(failedPayload, "observation.invalid"));

      invalidValue = 5;
      const recovered = await metrics.flush();
      assert.deepEqual(recovered.gaugeFailures, []);
      const recoveredPayload = collector.requests[1];
      assert.isDefined(recoveredPayload);
      assert.equal(
        metricNamed(recoveredPayload, "observation.invalid")?.gauge?.dataPoints[0]?.asDouble,
        5,
      );
      assert.equal(
        metricNamed(recoveredPayload, "observation.valid")?.gauge?.dataPoints[0]?.asDouble,
        7,
      );
      assert.equal(invalidCalls, 2);
      assert.equal(validCalls, 2);
      await metrics.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("rejects 101 gauge observations without a partial series and recovers", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      let observationCount = 101;
      let callbackCalls = 0;
      let validCalls = 0;
      metrics.counter({ name: "series.total", description: "Total", unit: "1" }).add(1);
      metrics.observableGauge(
        { name: "series.valid", description: "Valid series", unit: "1" },
        () => {
          validCalls++;
          return [{ value: 9 }];
        },
      );
      metrics.observableGauge(
        { name: "series.overflow", description: "Series overflow", unit: "1" },
        () => {
          callbackCalls++;
          return Array.from({ length: observationCount }, (_, index) => ({
            value: index,
            attributes: [{ key: "series.value", value: index }],
          }));
        },
      );

      const failed = await metrics.flush();
      const failure = failed.gaugeFailures[0];
      assert.isDefined(failure);
      assert.equal(failed.gaugeFailures.length, 1);
      assert.equal(failure.instrumentName, "series.overflow");
      assert.equal(failure.code, "SERIES_LIMIT_EXCEEDED");
      assert.equal(
        failure.message,
        'Observable gauge "series.overflow" exceeds the 100-observation collection limit.',
      );
      assert.isFalse(Object.hasOwn(failure, "retryable"));
      const failedPayload = collector.requests[0];
      assert.isDefined(failedPayload);
      assert.isDefined(metricNamed(failedPayload, "series.total"));
      assert.equal(metricNamed(failedPayload, "series.valid")?.gauge?.dataPoints[0]?.asDouble, 9);
      assert.isUndefined(metricNamed(failedPayload, "series.overflow"));

      observationCount = 1;
      const recovered = await metrics.flush();
      assert.deepEqual(recovered.gaugeFailures, []);
      const recoveredPayload = collector.requests[1];
      assert.isDefined(recoveredPayload);
      const recoveredGauge = metricNamed(recoveredPayload, "series.overflow");
      assert.equal(recoveredGauge?.gauge?.dataPoints.length, 1);
      assert.equal(recoveredGauge?.gauge?.dataPoints[0]?.asDouble, 0);
      assert.equal(
        metricNamed(recoveredPayload, "series.valid")?.gauge?.dataPoints[0]?.asDouble,
        9,
      );
      assert.equal(callbackCalls, 2);
      assert.equal(validCalls, 2);
      await metrics.close();
    } finally {
      await closeServer(collector.server);
    }
  });

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
          { value: gaugeValue, attributes: [{ key: "worker.name", value: "alpha" }] },
          { value: gaugeValue + 1, attributes: [{ key: "worker.name", value: "beta" }] },
        ],
      );
      counter.add(2, [{ key: "region.name", value: "south" }]);
      histogram.record(12, [{ key: "region.name", value: "south" }]);

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
      first.add(1, [{ key: "series.value", value: 0 }]);
      second.add(2, [{ key: "series.value", value: 0 }]);
      for (let index = 1; index < 100; index++) {
        first.add(1, [{ key: "series.value", value: index }]);
      }
      let cardinalityFailure: MetricsError | undefined;
      try {
        first.add(1, [{ key: "series.value", value: 100 }]);
      } catch (cause) {
        if (cause instanceof MetricsError) cardinalityFailure = cause;
      }
      assert.strictEqual(cardinalityFailure?.code, "LIMIT_EXCEEDED");
      assert.strictEqual(cardinalityFailure?.attributeKey, "series.value");
      await metrics.flush();
      const payload = collector.requests[0];
      assert.isDefined(payload);
      const exported = metricNamed(payload, "cardinality.total");
      assert.equal(exported?.sum?.dataPoints.length, 100);
      assert.equal(exported?.sum?.dataPoints[0]?.asDouble, 3);
      await metrics.close();
      const afterClose = keeper.counter({
        name: "cardinality.total",
        description: "Cardinality total",
        unit: "1",
      });
      afterClose.add(1, [{ key: "series.value", value: 99 }]);
      assert.equal(
        errorCode(() => afterClose.add(1, [{ key: "series.value", value: 100 }])),
        "LIMIT_EXCEEDED",
      );
      await keeper.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("enforces the instrument-name limit for the complete runtime lifetime", async () => {
    const collector = await startCollector();
    try {
      const metrics = await createMetrics(options(collector.endpoint));
      for (let index = 0; index < 100; index++) {
        metrics
          .observableGauge(
            {
              name: `lifetime.gauge.${index}`,
              description: "Lifetime gauge",
              unit: "1",
            },
            () => [{ value: index }],
          )
          .unregister();
      }
      assert.equal(
        errorCode(() =>
          metrics.counter({
            name: "lifetime.counter.overflow",
            description: "Lifetime overflow",
            unit: "1",
          }),
        ),
        "LIMIT_EXCEEDED",
      );
      await metrics.close();
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

  it("keeps shared cumulative counter and histogram values after one lease closes", async () => {
    const collector = await startCollector();
    try {
      const first = await createMetrics(options(collector.endpoint));
      const second = await createMetrics(options(collector.endpoint));
      first.counter({ name: "shared.counter", description: "Shared counter", unit: "1" }).add(2);
      second.counter({ name: "shared.counter", description: "Shared counter", unit: "1" }).add(3);
      first
        .histogram({
          name: "shared.histogram",
          description: "Shared histogram",
          unit: "ms",
          boundaries: [10, 20],
        })
        .record(5);
      const secondHistogram = second.histogram({
        name: "shared.histogram",
        description: "Shared histogram",
        unit: "ms",
        boundaries: [10, 20],
      });
      secondHistogram.record(15);

      await first.flush();
      await first.close();
      await second.flush();

      const beforeClose = collector.requests[0];
      const afterClose = collector.requests[2];
      assert.isDefined(beforeClose);
      assert.isDefined(afterClose);
      const initialCounter = metricNamed(beforeClose, "shared.counter")?.sum?.dataPoints[0];
      const retainedCounter = metricNamed(afterClose, "shared.counter")?.sum?.dataPoints[0];
      const initialHistogram = metricNamed(beforeClose, "shared.histogram")?.histogram
        ?.dataPoints[0];
      const retainedHistogram = metricNamed(afterClose, "shared.histogram")?.histogram
        ?.dataPoints[0];
      assert.equal(initialCounter?.asDouble, 5);
      assert.equal(retainedCounter?.asDouble, 5);
      assert.equal(retainedCounter?.startTimeUnixNano, initialCounter?.startTimeUnixNano);
      assert.equal(initialHistogram?.count, 2);
      assert.equal(retainedHistogram?.count, 2);
      assert.equal(initialHistogram?.sum, 20);
      assert.equal(retainedHistogram?.sum, 20);
      assert.deepEqual(retainedHistogram?.bucketCounts, [1, 1, 0]);
      assert.equal(retainedHistogram?.startTimeUnixNano, initialHistogram?.startTimeUnixNano);

      second.counter({ name: "shared.counter", description: "Shared counter", unit: "1" }).add(4);
      secondHistogram.record(25);
      await second.flush();
      const afterMoreMeasurements = collector.requests[3];
      assert.isDefined(afterMoreMeasurements);
      assert.equal(
        metricNamed(afterMoreMeasurements, "shared.counter")?.sum?.dataPoints[0]?.asDouble,
        9,
      );
      assert.equal(
        metricNamed(afterMoreMeasurements, "shared.histogram")?.histogram?.dataPoints[0]?.count,
        3,
      );
      assert.equal(
        metricNamed(afterMoreMeasurements, "shared.histogram")?.histogram?.dataPoints[0]?.sum,
        45,
      );
      await second.close();
    } finally {
      await closeServer(collector.server);
    }
  });

  it("exports facade and direct Effect metrics through the later layer capture transport", async () => {
    const config = new TelemetryConfig({
      identity: Effect.runSync(
        parseResourceIdentity({
          serviceName: "mixed-metrics-test",
          serviceVersion: "1.0.0",
          environment: "test",
        }),
      ),
      otlpEndpoint: new URL("http://mixed-metrics.invalid"),
    });
    const facade = await createMetrics({
      serviceName: config.identity.serviceName,
      serviceVersion: config.identity.serviceVersion,
      environment: config.identity.environment,
      otlpEndpoint: config.otlpEndpoint.toString(),
    });
    const capture = await Effect.runPromise(Testing.makeCapture({ config }));
    const runtime = ManagedRuntime.make(capture.layer);
    try {
      facade.counter({ name: "mixed.facade", description: "Facade counter", unit: "1" }).add(2);
      const direct = Metric.counter("mixed.direct", {
        description: "Direct counter",
        attributes: { unit: "By" },
      });
      await runtime.runPromise(Metric.update(direct, 4));
      await facade.flush();

      const telemetry = await Effect.runPromise(capture.telemetry);
      const facadeMetric = telemetry.metrics.find((metric) => metric.name === "mixed.facade");
      const directMetric = telemetry.metrics.find((metric) => metric.name === "mixed.direct");
      assert.isDefined(facadeMetric);
      assert.isDefined(directMetric);
      const facadePoint = facadeMetric.points[0];
      const directPoint = directMetric.points[0];
      assert.isDefined(facadePoint);
      assert.isDefined(directPoint);
      assert.equal(Option.getOrUndefined(facadePoint.value), 2);
      assert.equal(Option.getOrUndefined(directPoint.value), 4);
      assert.equal(directMetric.unit, "By");
      assert.isTrue(directMetric.points.every((point) => !point.attributes.has("unit")));
      await facade.close();
    } finally {
      await runtime.dispose();
    }
  });

  it("hard rejects service.instance.id on a direct Effect metric datapoint", async () => {
    const config = new TelemetryConfig({
      identity: Effect.runSync(
        parseResourceIdentity({
          serviceName: "direct-instance-test",
          serviceVersion: "1.0.0",
          environment: "test",
        }),
      ),
      otlpEndpoint: new URL("http://direct-instance.invalid"),
    });
    const facade = await createMetrics({
      serviceName: config.identity.serviceName,
      serviceVersion: config.identity.serviceVersion,
      environment: config.identity.environment,
      otlpEndpoint: config.otlpEndpoint.toString(),
    });
    const capture = await Effect.runPromise(Testing.makeCapture({ config }));
    const runtime = ManagedRuntime.make(capture.layer);
    try {
      const direct = Metric.counter("direct.instance", {
        description: "Direct instance counter",
        attributes: { "service.instance.id": "instance-1" },
      });
      await runtime.runPromise(Metric.update(direct, 1));
      let failure: MetricsError | undefined;
      try {
        await facade.flush();
      } catch (cause) {
        if (cause instanceof MetricsError) failure = cause;
      }
      assert.strictEqual(failure?.code, "EXPORT_FAILED");
      const telemetry = await Effect.runPromise(capture.telemetry);
      assert.notInclude(JSON.stringify(telemetry.metrics), "instance-1");
      await facade.close().catch(() => undefined);
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });

  it("surfaces evidence-safe policy reasons for direct metric failures", async () => {
    const config = new TelemetryConfig({
      identity: Effect.runSync(
        parseResourceIdentity({
          serviceName: "direct-policy-test",
          serviceVersion: "1.0.0",
          environment: "test",
        }),
      ),
      otlpEndpoint: new URL("http://direct-policy.invalid"),
    });
    const facade = await createMetrics({
      serviceName: config.identity.serviceName,
      serviceVersion: config.identity.serviceVersion,
      environment: config.identity.environment,
      otlpEndpoint: config.otlpEndpoint.toString(),
    });
    const capture = await Effect.runPromise(Testing.makeCapture({ config }));
    const runtime = ManagedRuntime.make(capture.layer);
    try {
      const direct = Metric.counter("direct.policy", {
        description: "Direct policy counter",
        attributes: { "http.authorization": "hidden" },
      });
      await runtime.runPromise(Metric.update(direct, 1));
      const result = await facade.flush();
      assert.deepStrictEqual(result.gaugeFailures, [
        {
          instrumentName: "direct.policy",
          code: "POLICY_BLOCKED",
          message: 'Metric "direct.policy" dropped a label blocked by the data policy.',
          policyReason: "attribute-name",
        },
      ]);
      assert.notInclude(JSON.stringify(result), "http.authorization");
      assert.notInclude(JSON.stringify(result), "hidden");
      await facade.close();
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects facade and direct Effect name conflicts before sending OTLP", async () => {
    const config = new TelemetryConfig({
      identity: Effect.runSync(
        parseResourceIdentity({
          serviceName: "mixed-conflict-test",
          serviceVersion: "1.0.0",
          environment: "test",
        }),
      ),
      otlpEndpoint: new URL("http://mixed-conflict.invalid"),
    });
    const facade = await createMetrics({
      serviceName: config.identity.serviceName,
      serviceVersion: config.identity.serviceVersion,
      environment: config.identity.environment,
      otlpEndpoint: config.otlpEndpoint.toString(),
    });
    const capture = await Effect.runPromise(Testing.makeCapture({ config }));
    const runtime = ManagedRuntime.make(capture.layer);
    try {
      facade.counter({ name: "mixed.conflict", description: "Facade counter", unit: "1" }).add(1);
      const direct = Metric.gauge("mixed.conflict", {
        description: "Direct gauge",
      });
      await runtime.runPromise(Metric.update(direct, 3));
      let conflict: MetricsError | undefined;
      try {
        await facade.flush();
      } catch (cause) {
        if (cause instanceof MetricsError) {
          conflict = cause;
        }
      }
      assert.isDefined(conflict);
      assert.equal(conflict.code, "EXPORT_FAILED");
      assert.equal(conflict.instrumentName, "mixed.conflict");
      assert.isFalse(conflict.retryable);
      const telemetry = await Effect.runPromise(capture.telemetry);
      assert.equal(telemetry.metrics.length, 0);
      assert.equal(
        await asyncErrorCode(async () => {
          await facade.close();
        }),
        "EXPORT_FAILED",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("emits periodic failed and recovered notices once per transition", async () => {
    const collector = await startCollector();
    const notices: Array<string> = [];
    const previousWarn = console.warn;
    const captureWarning = (message?: string): void => {
      if (message !== undefined) {
        notices.push(message);
      }
    };
    console.warn = captureWarning;
    try {
      collector.control.status = 503;
      const metrics = await createMetrics({
        ...options(collector.endpoint, 200),
        exportIntervalMilliseconds: 15,
      });
      metrics.counter({ name: "periodic.total", description: "Periodic", unit: "1" }).add(1);
      await waitFor(() => notices.length === 1 && collector.requests.length >= 1);
      await waitFor(() => collector.requests.length >= 3);
      assert.deepEqual(notices, [
        "OBS_METRICS_PERIODIC_EXPORT_FAILED: The periodic metrics export entered a failed state.",
      ]);

      collector.control.status = 200;
      await waitFor(() => notices.length === 2);
      const recoveredRequestCount = collector.requests.length;
      await waitFor(() => collector.requests.length >= recoveredRequestCount + 2);
      assert.deepEqual(notices, [
        "OBS_METRICS_PERIODIC_EXPORT_FAILED: The periodic metrics export entered a failed state.",
        "OBS_METRICS_PERIODIC_EXPORT_RECOVERED: The periodic metrics export recovered.",
      ]);
      await metrics.close();
    } finally {
      console.warn = previousWarn;
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
      counter.add(1, [{ key: "safe.value", value: true }]);
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
