import { Effect, Ref } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { observabilityProfiles } from "../src/profile/ObservabilityProfile.ts";
import {
  ConformanceViolation,
  conformanceChecks,
  defineConformanceEvidenceProvider,
  runConformance,
  type ConformanceCheckId,
  type ConformanceEvidenceProvider,
  type ConformanceTarget,
  type ConformanceTargetContext,
} from "../src/testing/index.ts";

const binding = {
  identity: { serviceName: "delegation-service", serviceVersion: "1.0.0", environment: "staging" },
  contract: {
    index: 1 as const,
    contractVersion: 1,
    service: "delegation-service",
    events: [],
    metrics: [],
    aliases: [],
  },
};

const workerContext: ConformanceTargetContext = {
  name: "delegation-target",
  profile: observabilityProfiles.worker,
  environment: "staging",
  topology: "local",
  capabilities: { traces: true, metrics: true, defects: false, browserIngest: false, audit: false },
  binding,
};

const applicableIds = conformanceChecks
  .filter((check) => check.applies(workerContext))
  .map((check) => check.id);

const delegationTarget = (
  providers: ReadonlyArray<ConformanceEvidenceProvider>,
): ConformanceTarget => ({
  name: "delegation-target",
  profile: "worker",
  environment: "staging",
  topology: "local",
  capabilities: { traces: true, metrics: true, defects: false, browserIngest: false, audit: false },
  binding,
  providers,
});

const sentinelProvider = (
  id: ConformanceCheckId,
  calls: Ref.Ref<
    ReadonlyArray<{ readonly id: ConformanceCheckId; readonly target: ConformanceTargetContext }>
  >,
): ConformanceEvidenceProvider =>
  defineConformanceEvidenceProvider({
    id,
    owner: "application",
    verify: (target) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (entries) => [...entries, { id, target }]);
        return {
          owner: "application",
          receiptType: "sentinel",
          receiptId: `receipt-${id}`,
          summary: "sentinel evidence",
        };
      }),
  });

describe("conformance delegation", () => {
  it("runs every applicable provider exactly once with the exact target context", async () => {
    const calls = await Effect.runPromise(
      Ref.make<
        ReadonlyArray<{
          readonly id: ConformanceCheckId;
          readonly target: ConformanceTargetContext;
        }>
      >([]),
    );
    const providers = applicableIds.map((id) => sentinelProvider(id, calls));
    const report = await Effect.runPromise(runConformance(delegationTarget(providers)));
    expect(report.conforms).toBe(true);
    const observed = await Effect.runPromise(Ref.get(calls));
    expect(observed.map((entry) => entry.id).toSorted()).toEqual(applicableIds.toSorted());
    for (const entry of observed) {
      expect(entry.target.name).toBe("delegation-target");
      expect(entry.target.environment).toBe("staging");
      expect(entry.target.topology).toBe("local");
      expect(entry.target.profile.name).toBe("worker");
    }
    for (const check of report.checks) {
      if (check.status !== "pass") continue;
      expect(check.evidence.receiptId).toBe(`receipt-${check.id}`);
      expect(check.evidence.receiptType).toBe("sentinel");
    }
  });

  it("maps sentinel provider violations onto the official code and rule without reinterpretation", async () => {
    const violation = new ConformanceViolation({
      message: "owner sentinel violation",
      offendingValue: "sentinel-offender",
      cause: "sentinel-offender",
    });
    const providers = applicableIds.map((id) =>
      defineConformanceEvidenceProvider({
        id,
        owner: "application",
        verify: () => Effect.fail(violation),
      }),
    );
    const report = await Effect.runPromise(runConformance(delegationTarget(providers)));
    expect(report.conforms).toBe(false);
    const registry = new Map(conformanceChecks.map((check) => [check.id, check]));
    for (const check of report.checks) {
      if (check.status !== "fail") continue;
      const entry = registry.get(check.id);
      expect(check.failure.message).toBe("owner sentinel violation");
      expect(check.failure.offendingValue).toBe("sentinel-offender");
      expect(check.failure.code).toBe(entry?.code);
      expect(check.failure.rule).toEqual(entry?.rule);
    }
  });

  it("reports conformance failures as report data and never as suite errors", async () => {
    const providers = applicableIds.map((id) =>
      defineConformanceEvidenceProvider({
        id,
        owner: "application",
        verify: () =>
          Effect.fail(
            new ConformanceViolation({
              message: "broken",
              offendingValue: "broken",
              cause: "broken",
            }),
          ),
      }),
    );
    const exit = await Effect.runPromiseExit(runConformance(delegationTarget(providers)));
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.conforms).toBe(false);
      expect(
        exit.value.checks
          .filter((check) => check.status !== "not-applicable")
          .every((check) => check.status === "fail"),
      ).toBe(true);
    }
  });
});
