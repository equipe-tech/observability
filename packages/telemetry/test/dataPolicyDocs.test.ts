import { readFile } from "node:fs/promises";
import { assert, describe, it } from "vite-plus/test";

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

type CollectorSignal = "traces" | "logs" | "metrics";

const collectorSignals: ReadonlyArray<CollectorSignal> = ["traces", "logs", "metrics"];
const redactionProcessors = new Set(["redaction/sensitive", "transform/redact"]);

const readProcessorOrder = (config: string, signal: CollectorSignal): string[] => {
  const servicePipelines = config.slice(config.lastIndexOf("  pipelines:\n"));
  const pipeline = new RegExp(
    `    ${signal}:\\n([\\s\\S]*?)(?=    (?:traces|logs|metrics):|$)`,
  ).exec(servicePipelines)?.[1];
  if (pipeline === undefined) {
    assert.fail(`Missing ${signal} service pipeline`);
  }
  const processors = /processors:\s*(?:\n\s*)?\[([^\]]+)\]/.exec(pipeline)?.[1];
  if (processors === undefined) {
    assert.fail(`Missing ${signal} processor order`);
  }
  return processors.split(",").map((processor) => processor.trim());
};

const readRedactionOrder = (config: string, signal: CollectorSignal): string[] =>
  readProcessorOrder(config, signal).filter((processor) => redactionProcessors.has(processor));

describe("data policy documentation", () => {
  it("matches the documented redaction order to both Collector assets", async () => {
    const [policy, local, production] = await Promise.all([
      readRepositoryFile("docs/browser-telemetry-data-policy.md"),
      readRepositoryFile("packages/cli/src/assets/local.yaml"),
      readRepositoryFile("packages/cli/src/assets/production.yaml"),
    ]);
    const documentedOrder = readRedactionOrder(local, "traces");
    assert.lengthOf(documentedOrder, redactionProcessors.size);
    for (const config of [local, production]) {
      for (const signal of collectorSignals) {
        assert.deepEqual(readRedactionOrder(config, signal), documentedOrder);
      }
    }
    assert.include(
      policy,
      documentedOrder.map((processor) => `\`${processor}\``).join(" runs before "),
    );
  });

  it("links the Portuguese reference from the repository and related guides", async () => {
    const [readme, metrics, contract, policy] = await Promise.all([
      readRepositoryFile("README.md"),
      readRepositoryFile("docs/metrics.md"),
      readRepositoryFile("docs/telemetry-contract.md"),
      readRepositoryFile("docs/data-policy.md"),
    ]);
    assert.include(readme, "docs/data-policy.md");
    assert.include(metrics, "data-policy.md");
    assert.include(contract, "data-policy.md");
    assert.include(policy, "# Referência da política de dados");
    assert.include(policy, "Classificações");
    assert.notInclude(policy, "# Data policy reference");
  });
});
