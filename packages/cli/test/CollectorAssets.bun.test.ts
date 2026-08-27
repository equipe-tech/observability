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

const decodeCollectorConfig = Schema.decodeUnknownSync(CollectorConfig);

const collectorBlock = (config: string, startMarker: string, endMarker: string): string => {
  const start = config.indexOf(startMarker);
  const end = config.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return config.slice(start, end);
};

const environmentBlock = (config: string): string =>
  collectorBlock(config, "  transform/environment:", "  transform/redact:");

const redactionBlock = (config: string): string =>
  collectorBlock(config, "  transform/redact:", "  batch:");

const legacyToCanonical =
  'set(resource.attributes["deployment.environment.name"], resource.attributes["deployment.environment"]) where resource.attributes["deployment.environment.name"] == nil and resource.attributes["deployment.environment"] != nil';
const canonicalToLegacy =
  'set(resource.attributes["deployment.environment"], resource.attributes["deployment.environment.name"]) where resource.attributes["deployment.environment.name"] != nil';

const expectCollectorContract = (config: string): void => {
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
    "transform/redact",
    "redaction/sensitive",
    "batch",
  ];
  const metrics = ["memory_limiter", "transform/environment", "redaction/sensitive", "batch"];
  expect(pipelines.traces.processors).toEqual(tracesAndLogs);
  expect(pipelines.logs.processors).toEqual(tracesAndLogs);
  expect(pipelines.metrics.processors).toEqual(metrics);
};

describe("Collector assets", () => {
  test("keep environment transition and redaction contracts across local and production", async () => {
    const [local, production] = await Promise.all([
      Bun.file(new URL("../src/assets/local.yaml", import.meta.url)).text(),
      Bun.file(new URL("../src/assets/production.yaml", import.meta.url)).text(),
    ]);

    expect(environmentBlock(local)).toBe(environmentBlock(production));
    expect(redactionBlock(local)).toBe(redactionBlock(production));
    expectCollectorContract(local);
    expectCollectorContract(production);

    const withoutTraceAttributeRedaction = production.replace(
      "transform/redact, redaction/sensitive",
      "transform/redact",
    );
    expect(withoutTraceAttributeRedaction).not.toBe(production);
    expect(() => expectCollectorContract(withoutTraceAttributeRedaction)).toThrow(
      /redaction\/sensitive/,
    );
  });
});
