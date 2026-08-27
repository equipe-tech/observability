import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

const CollectorPipeline = Schema.Struct({
  processors: Schema.Array(Schema.String),
});

const CollectorConfig = Schema.Struct({
  service: Schema.Struct({
    pipelines: Schema.Struct({
      traces: CollectorPipeline,
      logs: CollectorPipeline,
      metrics: CollectorPipeline,
    }),
  }),
});

const decodeCollectorConfig = Schema.decodeUnknownSync(CollectorConfig);

const redactionBlock = (config: string): string => {
  const start = config.indexOf("  transform/redact:");
  const end = config.indexOf("  batch:", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return config.slice(start, end);
};

const expectRedactionPipelines = (config: string): void => {
  const parsed: unknown = Bun.YAML.parse(config);
  const pipelines = decodeCollectorConfig(parsed).service.pipelines;
  const tracesAndLogs = ["memory_limiter", "transform/redact", "redaction/sensitive", "batch"];
  const metrics = ["memory_limiter", "redaction/sensitive", "batch"];
  expect(pipelines.traces.processors).toEqual(tracesAndLogs);
  expect(pipelines.logs.processors).toEqual(tracesAndLogs);
  expect(pipelines.metrics.processors).toEqual(metrics);
};

describe("Collector assets", () => {
  test("keep one redaction contract across local and production pipelines", async () => {
    const [local, production] = await Promise.all([
      Bun.file(new URL("../src/assets/local.yaml", import.meta.url)).text(),
      Bun.file(new URL("../src/assets/production.yaml", import.meta.url)).text(),
    ]);

    expect(redactionBlock(local)).toBe(redactionBlock(production));
    expectRedactionPipelines(local);
    expectRedactionPipelines(production);

    const withoutTraceAttributeRedaction = production.replace(
      "processors: [memory_limiter, transform/redact, redaction/sensitive, batch]",
      "processors: [memory_limiter, transform/redact, batch]",
    );
    expect(withoutTraceAttributeRedaction).not.toBe(production);
    expect(() => expectRedactionPipelines(withoutTraceAttributeRedaction)).toThrow(
      /redaction\/sensitive/,
    );
  });
});
