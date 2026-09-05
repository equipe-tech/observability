import { readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { parseOperationsManifest } from "../packages/cli/src/OperationsManifest.ts";
import { Contract } from "../packages/telemetry/src/index.ts";
import { decodeCompatibilityJson, encodeCompatibilityJson } from "./compatibility-json.ts";

export type CompatibilityCandidateMetadata = {
  readonly contractSurface: Contract.ContractSurface;
};

const retentionWindowDays = async (): Promise<number> => {
  const manifest = await Effect.runPromise(
    parseOperationsManifest(readFileSync("observability/operations.yaml", "utf8")),
  );
  return Math.max(...manifest.retention.map((entry) => entry.days));
};

export const loadCompatibilityCandidateMetadata =
  async (): Promise<CompatibilityCandidateMetadata> => {
    const generated = Bun.spawnSync({
      cmd: [
        "bun",
        "observability/contract-index.js",
        "--surface",
        String(await retentionWindowDays()),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (generated.exitCode !== 0)
      throw new Error(
        `Compiled observability contract surface failed: ${generated.stderr.toString()}`,
      );
    const contractSurface = await Effect.runPromise(
      decodeCompatibilityJson(generated.stdout.toString()),
    );
    return { contractSurface };
  };

export const generateCompatibilityCandidate = async (
  metadata?: CompatibilityCandidateMetadata,
): Promise<string> => {
  const resolved = metadata ?? (await loadCompatibilityCandidateMetadata());
  return await encodeCompatibilityJson(resolved.contractSurface);
};

if (import.meta.main) {
  writeFileSync(
    "observability/compatibility/candidate.json",
    await generateCompatibilityCandidate(),
  );
}
