import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  maximumContractAliasCount,
  maximumContractAliasDepth,
  maximumContractAliasTargets,
} from "../src/OperationsManifest.ts";

const cliPolicyPath = fileURLToPath(new URL("../src/OperationsManifest.ts", import.meta.url));
const telemetryPolicyPath = fileURLToPath(
  new URL("../../telemetry/src/contract/ContractIndex.ts", import.meta.url),
);

const readLimits = async (path: string) => {
  const source = await Bun.file(path).text();
  const count = source.match(/maximumContractAliasCount = ([\d_]+);/)?.[1];
  const depth = source.match(/maximumContractAliasDepth = ([\d_]+);/)?.[1];
  const targets = source.match(/maximumContractAliasTargets = ([\d_]+);/)?.[1];
  if (count === undefined || depth === undefined || targets === undefined) {
    throw new Error(`Contract alias limits are missing from ${path}.`);
  }
  return {
    count: Number(count.replaceAll("_", "")),
    depth: Number(depth.replaceAll("_", "")),
    targets: Number(targets.replaceAll("_", "")),
  };
};

describe("CLI contract alias policy ownership seam", () => {
  test("matches telemetry generator count, depth and target limits", async () => {
    const cli = await readLimits(cliPolicyPath);
    const telemetry = await readLimits(telemetryPolicyPath);

    expect(cli).toEqual(telemetry);
    expect(cli).toEqual({
      count: maximumContractAliasCount,
      depth: maximumContractAliasDepth,
      targets: maximumContractAliasTargets,
    });
  });
});
