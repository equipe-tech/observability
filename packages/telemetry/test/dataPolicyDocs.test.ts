import { readFile } from "node:fs/promises";
import { assert, describe, it } from "vite-plus/test";

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("data policy documentation", () => {
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
