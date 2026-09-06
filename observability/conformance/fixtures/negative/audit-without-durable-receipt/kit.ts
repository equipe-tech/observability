import { Effect } from "effect";
import {
  assertConformanceFailure,
  auditConformance,
  runConformance,
  type ConformanceCheckId,
  type ConformanceProfileReport,
  type ConformanceTarget,
} from "@equipe-tech/observability/testing";
import { buildNestjsConformance } from "../../positive/nestjs-api/kit.ts";

export const runAuditWithoutDurableReceiptFixture = async (): Promise<ConformanceProfileReport> => {
  const built = await buildNestjsConformance();
  const target: ConformanceTarget = {
    name: "fixture-api",
    profile: "nestjs-api",
    environment: "test",
    topology: "local",
    capabilities: { traces: true, metrics: true, defects: true, browserIngest: false, audit: true },
    binding: built.kit.binding,
    providers: [
      ...built.providers.filter((provider) => provider.id !== "audit.durable-before-operational"),
      auditConformance({ commit: undefined, operationalAction: "fixture.updated" }),
    ],
  };
  return Effect.runPromise(runConformance(target));
};

export const expectAuditWithoutDurableReceiptFailure = async (): Promise<void> => {
  const report = await runAuditWithoutDurableReceiptFixture();
  await Effect.runPromise(
    assertConformanceFailure(
      report,
      "audit.durable-before-operational" satisfies ConformanceCheckId,
    ),
  );
};
