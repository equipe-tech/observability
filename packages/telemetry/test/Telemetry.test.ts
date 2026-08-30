import { assert, describe, it } from "@effect/vitest";
import { Cause, Console, Effect, Exit, Layer, Logger, Metric, Option, References } from "effect";
import type * as LogLevel from "effect/LogLevel";
import { parseResourceIdentity } from "../src/ResourceIdentity.ts";
import { logLevelSeverityNumber } from "../src/PolicyOtlpLogger.ts";
import { layer } from "../src/Telemetry.ts";
import { TelemetryConfig } from "../src/TelemetryConfig.ts";
import * as Testing from "../src/testing/index.ts";
import { parseDataPolicy } from "../src/policy/DataPolicy.ts";

const unavailableCollector = new TelemetryConfig({
  identity: Effect.runSync(
    parseResourceIdentity({
      serviceName: "telemetry-test",
      serviceVersion: "0.1.0",
      environment: "test",
    }),
  ),
  otlpEndpoint: new URL("http://127.0.0.1:1"),
});

describe("Telemetry.layer", () => {
  it("maps every Effect log level to the pinned OTLP severity", () => {
    const levels = [
      "All",
      "Trace",
      "Debug",
      "Info",
      "Warn",
      "Error",
      "Fatal",
      "None",
    ] satisfies ReadonlyArray<LogLevel.LogLevel>;
    assert.deepStrictEqual(levels.map(logLevelSeverityNumber), [0, 1, 5, 9, 13, 17, 21, 0]);
  });
  it.live("discriminates-effect-log-record-shape", () =>
    Effect.gen(function* () {
      const result = yield* Testing.run(
        Effect.logInfo("record-shape").pipe(
          Effect.annotateLogs({ "probe.value": "kept" }),
          Effect.withSpan("record.shape"),
        ),
      );
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "record-shape"),
      );
      assert.isDefined(log);
      assert.strictEqual(Option.getOrUndefined(log.severityText), "Info");
      assert.isTrue(Option.isSome(log.traceId));
      assert.isTrue(Option.isSome(log.spanId));
      assert.strictEqual(
        Option.getOrUndefined(Testing.attribute(log.attributes, "probe.value")),
        "kept",
      );
      assert.isTrue(Option.isSome(Testing.attribute(log.attributes, "fiberId")));
    }),
  );

  it.live("sanitizes console fallback before output", () =>
    Effect.gen(function* () {
      const secret = crypto.randomUUID().replaceAll("-", "");
      const messages: Array<string> = [];
      const recording: Console.Console = Object.assign(Object.create(globalThis.console), {
        log: (...args: Parameters<Console.Console["log"]>) => {
          messages.push(JSON.stringify(args));
        },
      });
      yield* Testing.run(
        Effect.logInfo(`Bearer ${secret}`).pipe(
          Effect.annotateLogs({ "http.authorization": secret }),
          Effect.provideService(Console.Console, recording),
        ),
      );
      assert.notInclude(JSON.stringify(messages), secret);
      assert.include(JSON.stringify(messages), "[REDACTED]");
      assert.include(JSON.stringify(messages), "****");
    }),
  );

  it.live("installs the compiled application policy in the runtime context", () =>
    Effect.gen(function* () {
      const policy = yield* parseDataPolicy({
        attributes: {},
        blockedKeys: ["customer[.]tier"],
        blockedValuePatterns: [],
      });
      const result = yield* Testing.run(
        Effect.logInfo("custom-policy").pipe(Effect.annotateLogs({ "customer.tier": "gold" })),
        { policy },
      );
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "custom-policy"),
      );
      assert.isDefined(log);
      assert.strictEqual(
        Option.getOrUndefined(Testing.attribute(log.attributes, "customer.tier")),
        "****",
      );
    }),
  );

  it.live("publishes the exact dropped attribute count", () =>
    Effect.gen(function* () {
      const annotations = {
        ...Object.fromEntries(
          Array.from({ length: 130 }, (_, index) => [`field.value${index}`, index]),
        ),
        "unsupported.value": { nested: true },
      };
      const result = yield* Testing.run(
        Effect.logInfo("drop-count").pipe(Effect.annotateLogs(annotations)),
      );
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "drop-count"),
      );
      assert.isDefined(log);
      assert.strictEqual(log.droppedAttributesCount, 3);
      assert.lengthOf(log.attributes, 129);
    }),
  );

  it.live("sanitizes direct Effect logs before OTLP buffering", () =>
    Effect.gen(function* () {
      const secret = crypto.randomUUID().replaceAll("-", "");
      const result = yield* Testing.run(
        Effect.logInfo(`Bearer ${secret} Bearer ${secret}`).pipe(
          Effect.annotateLogs({ "http.authorization": secret }),
        ),
      );
      assert.notInclude(JSON.stringify(result.telemetry), secret);
      const log = result.telemetry.logs[0];
      assert.isDefined(log);
      assert.strictEqual(
        Option.getOrUndefined(Testing.attribute(log.attributes, "http.authorization")),
        "****",
      );
    }),
  );

  it.live("delegates only sanitized records to an existing logger", () =>
    Effect.gen(function* () {
      const secret = crypto.randomUUID().replaceAll("-", "");
      const records: Array<string> = [];
      const existing = Logger.make((entry) => {
        records.push(
          JSON.stringify([
            entry.message,
            entry.fiber.getRef(References.CurrentLogAnnotations),
            Cause.pretty(entry.cause),
          ]),
        );
      });
      const policy = yield* parseDataPolicy({
        attributes: {},
        blockedKeys: [],
        blockedValuePatterns: ["provider_[A-Za-z0-9]+"],
      });
      const capture = yield* Testing.makeCapture({ policy });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(capture.layer).pipe(
            Effect.provide(Logger.layer([existing], { mergeWithExisting: true })),
          );
          yield* Effect.logInfo(
            `provider_${secret} provider_${secret}`,
            Cause.fail(`provider_${secret} provider_${secret}`),
          ).pipe(Effect.annotateLogs({ "http.authorization": secret }), Effect.provide(context));
        }),
      );
      assert.notInclude(JSON.stringify(records), secret);
      assert.include(JSON.stringify(records), "[REDACTED]");
      assert.include(JSON.stringify(records), "****");
    }),
  );

  it.live("preserves log spans and bounded Cause output", () =>
    Effect.gen(function* () {
      const result = yield* Testing.run(
        Effect.logInfo("bounded-cause", Cause.fail(`Error: ${"x".repeat(40_000)}`)).pipe(
          Effect.withLogSpan("database"),
        ),
      );
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "bounded-cause"),
      );
      assert.isDefined(log);
      assert.isTrue(Option.isSome(Testing.attribute(log.attributes, "logSpan.database")));
      const renderedCause = String(
        Option.getOrUndefined(Testing.attribute(log.attributes, "log.error")),
      );
      assert.strictEqual(renderedCause.length, 32_768);
      assert.include(renderedCause, "Error:");
    }),
  );

  it.live("sanitizes and bounds resources for logs, traces, and metrics", () =>
    Effect.gen(function* () {
      const secret = crypto.randomUUID().replaceAll("-", "");
      const policy = yield* parseDataPolicy({
        attributes: {},
        blockedKeys: [],
        blockedValuePatterns: ["provider_[A-Za-z0-9]+"],
      });
      const resourceAttributes = [
        {
          key: "deployment.note",
          value: `provider_${secret} provider_${secret}`,
        },
        { key: "deployment.long", value: "x".repeat(9_000) },
        ...Array.from({ length: 130 }, (_, index) => ({
          key: `resource.field${index}`,
          value: String(index),
        })),
      ];
      const result = yield* Testing.run(
        Effect.gen(function* () {
          yield* Effect.logInfo("resource-policy");
          yield* Metric.update(Metric.counter("resource.policy.count"), 1);
        }).pipe(Effect.withSpan("resource.policy")),
        { policy, resourceAttributes },
      );
      assert.notInclude(JSON.stringify(result.telemetry), secret);
      const span = result.telemetry.spans.find((candidate) => candidate.name === "resource.policy");
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "resource-policy"),
      );
      const metric = result.telemetry.metrics.find(
        (candidate) => candidate.name === "resource.policy.count",
      );
      assert.isDefined(span);
      assert.isDefined(log);
      assert.isDefined(metric);
      for (const resource of [
        span.resourceAttributes,
        log.resourceAttributes,
        metric.resourceAttributes,
      ]) {
        assert.strictEqual(resource.size, 128);
        assert.strictEqual(resource.get("deployment.note"), "[REDACTED] [REDACTED]");
        assert.strictEqual(String(resource.get("deployment.long")).length, 8_192);
      }
    }),
  );

  it.live("rejects duplicate resource attributes through layer construction", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Layer.build(
          layer(unavailableCollector, {
            resourceAttributes: [{ key: "service.name", value: "duplicate" }],
          }),
        ),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasDies(exit.cause));
        assert.include(JSON.stringify(exit.cause), "OBS_POLICY_DUPLICATE_RESOURCE_ATTRIBUTE");
      }
    }),
  );

  it.live("ignores hostile ambient resource identity and optional canonical keys", () =>
    Effect.gen(function* () {
      const previous = process.env["OTEL_RESOURCE_ATTRIBUTES"];
      process.env["OTEL_RESOURCE_ATTRIBUTES"] = [
        "service.namespace=hostile",
        "service.name=hostile",
        "service.version=999.0.0",
        "deployment.environment.name=hostile",
        "deployment.environment=hostile",
        "service.instance.id=hostile",
        "ambient.allowed=present",
      ].join(",");
      const identity = yield* parseResourceIdentity({
        serviceName: "canonical-service",
        serviceVersion: "1.2.3",
        environment: "production",
      });
      const config = new TelemetryConfig({
        identity,
        otlpEndpoint: new URL("http://telemetry.invalid"),
      });
      const result = yield* Testing.run(
        Effect.logInfo("hostile-resource-probe").pipe(Effect.withSpan("hostile.resource")),
        { config },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env["OTEL_RESOURCE_ATTRIBUTES"];
            } else {
              process.env["OTEL_RESOURCE_ATTRIBUTES"] = previous;
            }
          }),
        ),
      );
      assert.isTrue(Exit.isSuccess(result.exit));
      const span = result.telemetry.spans.find(
        (candidate) => candidate.name === "hostile.resource",
      );
      const log = result.telemetry.logs.find((candidate) =>
        Option.contains(candidate.body, "hostile-resource-probe"),
      );
      assert.isDefined(span);
      assert.isDefined(log);
      for (const resource of [span.resourceAttributes, log.resourceAttributes]) {
        assert.strictEqual(resource.get("service.namespace"), "equipe-tech");
        assert.strictEqual(resource.get("service.name"), "canonical-service");
        assert.strictEqual(resource.get("service.version"), "1.2.3");
        assert.strictEqual(resource.get("deployment.environment.name"), "production");
        assert.isFalse(resource.has("deployment.environment"));
        assert.isFalse(resource.has("service.instance.id"));
        assert.isFalse(resource.has("ambient.allowed"));
      }
    }),
  );

  it.live("does not fail the application when the collector is unavailable", () =>
    Effect.gen(function* () {
      let completed = false;
      yield* Effect.sync(() => {
        completed = true;
      }).pipe(
        Effect.withSpan("collector.unavailable"),
        Effect.provide(layer(unavailableCollector)),
      );
      assert.isTrue(completed);
    }).pipe(Effect.timeout("5 seconds")),
  );
});
