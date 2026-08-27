# Framework-neutral metrics

Use `@equipe-tech/observability/metrics` from NestJS, plain Node.js, or any other JavaScript runtime. The facade exports counters, histograms, observable gauges, bounded flush, and idempotent close without exposing Effect types.

```ts
import { createMetrics } from "@equipe-tech/observability/metrics";

const metrics = await createMetrics({
  serviceName: "checkout-api",
  serviceVersion: "1.4.0",
  environment: "production",
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

## Lifecycle

`createMetrics` validates the complete configuration before acquiring a runtime lease. Equal active configurations share one runtime, registry, periodic exporter, and lifecycle queue.

`add`, `record`, gauge registration, and unregister are synchronous. `flush` and `close` are asynchronous and bounded by `flushTimeoutMilliseconds`, which defaults to 3 seconds. A repeated `close` returns the same promise. Recording, registration, or flushing after close throws `MetricsError` with code `CLOSED`.

Observable callbacks run synchronously immediately before periodic, manual, and final exports. One callback may return up to 100 observations. Failures omit that gauge from the current export and appear in `FlushResult.gaugeFailures` without suppressing valid instruments. Unregistering the final callback removes the gauge from later exports.

Set `enabled: false` to retain validation and no-op handles without an exporter, timer, callback invocation, request, or retained runtime lease.

## Instrument identity

The metric name is the instrument identity within one runtime. Repeating the exact kind, description, unit, and histogram boundaries is compatible. Any mismatch throws `INSTRUMENT_CONFLICT` before creating a partial instrument.

Names use `[A-Za-z][A-Za-z0-9_.\-/]{0,254}`. Units are `1`, `%`, or a case-sensitive ASCII unit expression such as `ms`, `By/s`, or `m/s^2`. Descriptions contain 1 to 1,024 characters without control characters. Histograms require 1 to 50 finite, strictly increasing boundaries.

Counters accept finite additions greater than or equal to zero. Histograms accept any finite observation.

## Attributes and cardinality

Pass attributes as an array of `{ key, value }` items. Values are strings, finite numbers, or booleans. Duplicate keys, `unit`, and `time_unit` are rejected. A measurement accepts at most 16 attributes. Attribute keys contain at most 128 characters. String values contain at most 256 characters and no control characters.

The runtime enforces these lifetime limits:

- 100 instruments per runtime
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

`flush` and the final export from `close` reject with `EXPORT_FAILED` or `FLUSH_TIMED_OUT`. Both are retryable on an open lifecycle. `close` releases the runtime lease even when its final export rejects.
