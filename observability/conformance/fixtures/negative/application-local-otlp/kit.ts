import { Effect } from "effect";
import { packageBoundaryConformance } from "@equipe-tech/observability-cli/testing";
import {
  assertConformanceFailure,
  runConformance,
  type ConformanceCheckId,
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { fileURLToPath } from "node:url";
import { buildWorkerTarget, workerProviders } from "../../positive/worker/kit.ts";
import { startLocalCollector } from "../../../support/collector.ts";

export const runLocalOtlpNegativeFixture = async (): Promise<ConformanceProfileReport> => {
  const collector = await startLocalCollector();
  const kit = await buildWorkerTarget(collector);
  const target: ConformanceTarget = {
    name: "negative-local-otlp",
    profile: "worker",
    environment: "test",
    topology: "local",
    capabilities: { traces: true, metrics: true, defects: false, browserIngest: false, audit: false },
    providers: [
      ...(await workerProviders(kit, collector)).filter(
        (provider) => provider.id !== "pipeline.no-application-otlp",
      ),
      packageBoundaryConformance({
        projectRoot: fileURLToPath(new URL(".", import.meta.url)),
        sourceRoots: ["."],
      }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};

export const expectLocalOtlpFailure = async (): Promise<void> => {
  const report = await runLocalOtlpNegativeFixture();
  await Effect.runPromise(
    assertConformanceFailure(report, "pipeline.no-application-otlp" satisfies ConformanceCheckId),
  );
};
