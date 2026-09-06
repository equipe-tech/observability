# Framework-neutral metrics

Use `@equipe-tech/observability/metrics` from NestJS, plain Node.js, or any other JavaScript runtime. The facade exports counters, histograms, observable gauges, bounded flush, and idempotent close without exposing Effect types.

```ts
import { createMetrics } from "@equipe-tech/observability/metrics";

const metrics = await createMetrics({
  serviceName: "checkout-api",
  serviceVersion: "1.4.0",
  environment: "production",
  deploymentEnvironmentAlias: "omitted",
  otlpEndpoint: "http://localhost:4318",
});

const orders = metrics.counter({
  name: "orders.created",
  description: "Created orders",
  unit: "1",
});

const duration = metrics.histogram({
  name: "orders.duration",
  description: "Order duration",
  unit: "ms",
  boundaries: [10, 25, 50, 100, 250, 500],
});

const queue = metrics.observableGauge(
  {
    name: "orders.queue.depth",
    description: "Pending order count",
    unit: "1",
  },
  () => [{ value: 4, attributes: [{ key: "region", value: "south" }] }],
);

orders.add(1, [{ key: "region", value: "south" }]);
duration.record(42, [{ key: "region", value: "south" }]);
await metrics.flush();
queue.unregister();
await metrics.close();
```

## Configuration

`createMetrics` parses identity before acquiring a runtime. `serviceName` uses lowercase letters, numbers, and single hyphens between segments, with at most 63 characters. `environment` uses the same grammar with at most 32 characters. `serviceVersion` accepts SemVer 2.0.0 or a 7 to 64 character lowercase hexadecimal immutable release identifier. Metrics omit `service.instance.id` from resources.

`deploymentEnvironmentAlias` accepts `omitted` or `emitted` and defaults to `omitted`. `otlpEndpoint` must be an HTTP or HTTPS URL without credentials. `exportIntervalMilliseconds` and `flushTimeoutMilliseconds` must be positive safe integers when supplied. `enabled` accepts a boolean and defaults to `true`.

An identity failure throws `MetricsError` with code `INVALID_CONFIGURATION`. Its `field` and `rule` properties identify the rejected identity field and its exact grammar.

## Lifecycle

`createMetrics` validates the complete configuration before acquiring a runtime lease. Equal active configurations share one runtime, registry, periodic exporter, and lifecycle queue. They also share exactly one exporter when facade and layer leases overlap. The most recently acquired active layer binding provides the transport; the built-in fetch transport is the fallback when no layer binding is active. Transport identity is deliberately excluded from the pool key because including it would create parallel runtimes and duplicate exporters. `exportIntervalMilliseconds` controls periodic collection and defaults to 10,000 milliseconds.

`add`, `record`, gauge registration, and unregister are synchronous. `flush` and `close` are asynchronous and bounded by `flushTimeoutMilliseconds`, which defaults to 3 seconds. A repeated `close` returns the same promise. Recording, registration, or flushing after close throws `MetricsError` with code `CLOSED`. Cumulative counter and histogram values remain in the shared runtime after an individual lease closes and retain the runtime start time.

Observable callbacks run synchronously immediately before periodic, manual, and final exports. One callback may return up to 100 observations. Failures omit that gauge from the current export and appear in `FlushResult.gaugeFailures` without suppressing valid instruments. Unregistering the final callback removes the gauge from later exports.

Set `enabled: false` to validate configuration, instrument definitions, measurement values, and measurement attributes while returning no-op handles without an exporter, timer, callback invocation, request, or retained runtime lease. Disabled mode cannot report callback-result failures, definition conflicts, or active-runtime cardinality limits because it retains no catalog, callbacks, or series.

## Instrument identity

The metric name is the instrument identity within one runtime. Repeating the exact kind, description, unit, and histogram boundaries is compatible. A facade definition mismatch throws `INSTRUMENT_CONFLICT` before creating a partial instrument. A name collision discovered later against a direct Effect metric rejects export with non-retryable `EXPORT_FAILED` and sends no metrics request.

Names use `[A-Za-z][A-Za-z0-9_.\-/]{0,254}`. Units are `1`, `%`, or a case-sensitive ASCII unit expression such as `ms`, `By/s`, or `m/s^2`. Descriptions contain 1 to 1,024 characters without control characters. Histograms require 1 to 50 finite, strictly increasing boundaries.

Counters accept finite additions greater than or equal to zero. Histograms accept any finite observation.

## Attributes and cardinality

Pass attributes as an array of `{ key, value }` items. Values are strings, finite numbers, or booleans. Duplicate keys, `unit`, `time_unit`, and `service.instance.id` are rejected. Instance identity belongs only to log and trace resources, never metric resources or datapoints. A measurement accepts at most 16 attributes. Attribute keys contain at most 128 characters. String values contain at most 256 characters and no control characters.

The runtime enforces these lifetime limits:

- 100 facade instrument names per runtime lifetime
- 1,000 series identities per instrument
- 10,000 series identities per runtime
- 16 callbacks per observable gauge
- 100 observations per callback collection

Series identity sorts attribute keys and preserves scalar types, so string `"1"`, number `1`, and boolean `true` remain distinct. Cardinality limits do not reset after gauge unregister.

## Failures

Synchronous validation and registration failures throw `MetricsError` with one of these codes:

- `INVALID_CONFIGURATION`
- `INVALID_INSTRUMENT`
- `INVALID_MEASUREMENT`
- `INSTRUMENT_CONFLICT`
- `LIMIT_EXCEEDED`
- `CLOSED`

`flush` and the final export from `close` reject with `EXPORT_FAILED` or `FLUSH_TIMED_OUT`. Transport failures and timeouts are retryable on an open lifecycle. Definition and name-conflict export failures are not retryable until the conflicting instrument is renamed or aligned. A direct Effect Metric datapoint carrying `service.instance.id` also fails with non-retryable `EXPORT_FAILED`; remove the reserved key before another export. `close` releases the runtime lease even when its final export rejects.
