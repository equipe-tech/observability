import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

const CollectorPipeline = Schema.Struct({
  processors: Schema.Array(Schema.String),
});

const TransformStatementGroup = Schema.Struct({
  context: Schema.String,
  statements: Schema.Array(Schema.String),
});

const CollectorConfig = Schema.Struct({
  processors: Schema.Struct({
    "transform/environment": Schema.Struct({
      error_mode: Schema.String,
      trace_statements: Schema.Array(TransformStatementGroup),
      log_statements: Schema.Array(TransformStatementGroup),
      metric_statements: Schema.Array(TransformStatementGroup),
    }),
  }),
  service: Schema.Struct({
    pipelines: Schema.Struct({
      traces: CollectorPipeline,
      logs: CollectorPipeline,
      metrics: CollectorPipeline,
    }),
  }),
});

const QueueBatch = Schema.Struct({
  flush_timeout: Schema.String,
  min_size: Schema.Number,
  max_size: Schema.Number,
  sizer: Schema.String,
});

const SendingQueue = Schema.Struct({
  enabled: Schema.Boolean,
  storage: Schema.String,
  queue_size: Schema.Number,
  num_consumers: Schema.Number,
  block_on_overflow: Schema.Boolean,
  batch: QueueBatch,
});

const RetryPolicy = Schema.Struct({
  enabled: Schema.Boolean,
  initial_interval: Schema.String,
  max_interval: Schema.String,
  max_elapsed_time: Schema.Number,
});

const ProductionExporter = Schema.Struct({
  sending_queue: SendingQueue,
  retry_on_failure: RetryPolicy,
});

const ProductionConfig = Schema.Struct({
  extensions: Schema.Struct({
    "file_storage/queue": Schema.Struct({
      directory: Schema.String,
      create_directory: Schema.Boolean,
      max_size: Schema.Number,
      fsync: Schema.Boolean,
      recreate: Schema.Boolean,
    }),
    health_check: Schema.Struct({
      endpoint: Schema.String,
      path: Schema.String,
    }),
  }),
  receivers: Schema.Struct({
    otlp: Schema.Struct({
      protocols: Schema.Struct({
        grpc: Schema.Struct({
          endpoint: Schema.String,
          max_recv_msg_size_mib: Schema.Number,
        }),
        http: Schema.Struct({
          endpoint: Schema.String,
          max_request_body_size: Schema.Number,
        }),
      }),
    }),
  }),
  exporters: Schema.Struct({
    "otlphttp/traces": ProductionExporter,
    "otlphttp/logs": ProductionExporter,
    "otlphttp/metrics": ProductionExporter,
  }),
  service: Schema.Struct({
    telemetry: Schema.Struct({
      metrics: Schema.Struct({
        level: Schema.String,
        readers: Schema.Array(
          Schema.Struct({
            pull: Schema.Struct({
              exporter: Schema.Struct({
                prometheus: Schema.Struct({
                  host: Schema.String,
                  port: Schema.Number,
                }),
              }),
            }),
          }),
        ),
      }),
    }),
    extensions: Schema.Array(Schema.String),
  }),
});

const KamalAccessory = Schema.Struct({
  accessories: Schema.Struct({
    "otel-collector": Schema.Struct({
      service: Schema.String,
      image: Schema.String,
      directories: Schema.Array(
        Schema.Struct({
          local: Schema.String,
          remote: Schema.String,
          mode: Schema.String,
          owner: Schema.String,
        }),
      ),
      port: Schema.String,
      options: Schema.Struct({
        publish: Schema.Array(Schema.String),
        restart: Schema.String,
        user: Schema.String,
      }),
    }),
  }),
});

const decodeCollectorConfig = Schema.decodeUnknownSync(CollectorConfig);
const decodeProductionConfig = Schema.decodeUnknownSync(ProductionConfig);
const decodeKamalAccessory = Schema.decodeUnknownSync(KamalAccessory);

const collectorBlock = (config: string, startMarker: string, endMarker: string): string => {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return config.slice(start, end);
};

const environmentBlock = (config: string): string =>
  collectorBlock(config, "  transform/environment:", "  transform/redact:");

const redactionTransformBlock = (config: string): string =>
  collectorBlock(config, "  transform/redact:", "  redaction/sensitive:");

const sensitiveRedactionBlock = (config: string): string => {
  const endMarker = config.includes("\n  batch:") ? "\n  batch:" : "\nexporters:";
  return collectorBlock(config, "  redaction/sensitive:", endMarker);
};

const legacyToCanonical =
  'set(resource.attributes["deployment.environment.name"], resource.attributes["deployment.environment"]) where resource.attributes["deployment.environment.name"] == nil and resource.attributes["deployment.environment"] != nil';
const canonicalToLegacy =
  'set(resource.attributes["deployment.environment"], resource.attributes["deployment.environment.name"]) where resource.attributes["deployment.environment.name"] != nil';

const expectCollectorContract = (config: string, production: boolean): void => {
  const parsed: unknown = Bun.YAML.parse(config);
  const decoded = decodeCollectorConfig(parsed);
  const environment = decoded.processors["transform/environment"];
  const statementGroups = [
    environment.trace_statements,
    environment.log_statements,
    environment.metric_statements,
  ];
  expect(environment.error_mode).toBe("propagate");
  for (const statementGroup of statementGroups) {
    expect(statementGroup).toEqual([
      {
        context: "resource",
        statements: [legacyToCanonical, canonicalToLegacy],
      },
    ]);
  }

  const pipelines = decoded.service.pipelines;
  const tracesAndLogs = [
    "memory_limiter",
    "transform/environment",
    "redaction/sensitive",
    "transform/redact",
  ];
  const metrics = [
    "memory_limiter",
    "transform/environment",
    "redaction/sensitive",
    "transform/redact",
  ];
  if (!production) {
    tracesAndLogs.push("batch");
    metrics.push("batch");
  }
  expect(pipelines.traces.processors).toEqual(tracesAndLogs);
  expect(pipelines.logs.processors).toEqual(tracesAndLogs);
  expect(pipelines.metrics.processors).toEqual(metrics);

  const redaction = redactionTransformBlock(config);
  const bearer = redaction.indexOf("(?i)Bearer[[:space:]");
  const assignment = redaction.indexOf("(?:=>|[=:])[[:space:]");
  expect(bearer).toBeGreaterThanOrEqual(0);
  expect(assignment).toBeGreaterThan(bearer);
};

const expectProductionOperations = (config: string): void => {
  const parsed: unknown = Bun.YAML.parse(config);
  const decoded = decodeProductionConfig(parsed);
  expect(decoded.extensions["file_storage/queue"]).toEqual({
    directory: "/var/lib/otelcol/queue",
    create_directory: true,
    max_size: 2_147_483_648,
    fsync: true,
    recreate: false,
  });
  expect(decoded.extensions.health_check).toEqual({
    endpoint: "0.0.0.0:13133",
    path: "/health",
  });
  expect(decoded.receivers.otlp.protocols.grpc.max_recv_msg_size_mib).toBe(8);
  expect(decoded.receivers.otlp.protocols.http.max_request_body_size).toBe(8_388_608);
  expect(decoded.service.extensions).toEqual(["file_storage/queue", "health_check"]);
  expect(decoded.service.telemetry.metrics).toEqual({
    level: "detailed",
    readers: [{ pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8888 } } } }],
  });

  for (const exporter of [
    decoded.exporters["otlphttp/traces"],
    decoded.exporters["otlphttp/logs"],
    decoded.exporters["otlphttp/metrics"],
  ]) {
    expect(exporter.sending_queue).toEqual({
      enabled: true,
      storage: "file_storage/queue",
      queue_size: 64,
      num_consumers: 1,
      block_on_overflow: false,
      batch: {
        flush_timeout: "200ms",
        min_size: 1,
        max_size: 8_388_608,
        sizer: "bytes",
      },
    });
    expect(exporter.retry_on_failure).toEqual({
      enabled: true,
      initial_interval: "5s",
      max_interval: "30s",
      max_elapsed_time: 0,
    });
  }
};

describe("Collector assets", () => {
  test("keep environment transition and redaction contracts across local and production", async () => {
    const [local, production] = await Promise.all([
      Bun.file(new URL("../src/assets/local.yaml", import.meta.url)).text(),
      Bun.file(new URL("../src/assets/production.yaml", import.meta.url)).text(),
    ]);

    expect(environmentBlock(local)).toBe(environmentBlock(production));
    expect(redactionTransformBlock(local)).toBe(redactionTransformBlock(production));
    expect(sensitiveRedactionBlock(local).trimEnd()).toBe(
      sensitiveRedactionBlock(production).trimEnd(),
    );
    expectCollectorContract(local, false);
    expectCollectorContract(production, true);
    expectProductionOperations(production);

    const changedQueueCapacity = production.replace("queue_size: 64", "queue_size: 65");
    expect(changedQueueCapacity).not.toBe(production);
    expect(() => expectProductionOperations(changedQueueCapacity)).toThrow(/64/);

    const changedQueueBatchLimit = production.replace("max_size: 8388608", "max_size: 8388609");
    expect(changedQueueBatchLimit).not.toBe(production);
    expect(() => expectProductionOperations(changedQueueBatchLimit)).toThrow(/8388608/);

    const withoutTraceAttributeRedaction = production.replace(
      "redaction/sensitive, transform/redact",
      "transform/redact",
    );
    expect(withoutTraceAttributeRedaction).not.toBe(production);
    expect(() => expectCollectorContract(withoutTraceAttributeRedaction, true)).toThrow(
      /redaction\/sensitive/,
    );
  });

  test("binds health and metrics to loopback and prepares the Collector queue directory", async () => {
    const asset = await Bun.file(
      new URL("../src/assets/kamal.accessory.yml", import.meta.url),
    ).text();
    const rendered = asset.replaceAll("{{name}}", "verify-app");
    const parsed: unknown = Bun.YAML.parse(rendered);
    const decoded = decodeKamalAccessory(parsed).accessories["otel-collector"];

    expect(decoded.service).toBe("verify-app-otel-collector");
    expect(decoded.service).not.toBe("otel-collector");
    expect(decoded.image).toBe("otel/opentelemetry-collector-contrib:0.159.0");
    expect(decoded.directories).toEqual([
      {
        local: "/var/lib/observability/verify-app/collector/queue",
        remote: "/var/lib/otelcol/queue",
        mode: "0700",
        owner: "10001:10001",
      },
    ]);
    expect(decoded.port).toBe("127.0.0.1:13133:13133");
    expect(decoded.options).toEqual({
      publish: ["127.0.0.1:8888:8888"],
      restart: "unless-stopped",
      user: "10001:10001",
    });
    expect(rendered).not.toContain("volumes:");
    expect(rendered).not.toContain("healthcheck");
  });
});
