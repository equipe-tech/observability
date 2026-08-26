import { describe, expect, test } from "bun:test";

const redactionBlock = (config: string): string => {
  const start = config.indexOf("  transform/redact:");
  const end = config.indexOf("  batch:", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return config.slice(start, end);
};

describe("Collector assets", () => {
  test("keep one redaction contract across local and production pipelines", async () => {
    const [local, production] = await Promise.all([
      Bun.file(new URL("../src/assets/local.yaml", import.meta.url)).text(),
      Bun.file(new URL("../src/assets/production.yaml", import.meta.url)).text(),
    ]);

    expect(redactionBlock(local)).toBe(redactionBlock(production));
    for (const config of [local, production]) {
      expect(config).toContain("trace_statements:");
      expect(config).toContain("log_statements:");
      expect(config).toContain(
        "processors: [memory_limiter, transform/redact, redaction/sensitive, batch]",
      );
      expect(config).toContain("processors: [memory_limiter, redaction/sensitive, batch]");
    }
  });
});
