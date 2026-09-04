import { Cause, Effect, type Exit } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { observabilityProfiles } from "../src/profile/ObservabilityProfile.ts";
import {
  assertConforms,
  conformanceChecks,
  conformanceFailureCodes,
  defineConformanceEvidenceProvider,
  InvalidConformanceSuite,
  libraryLifecycleConformance,
  lifecycleConformance,
  profileConformance,
  runConformance,
  runConformanceSuite,
  type ConformanceCheckId,
  type ConformanceEvidenceProvider,
  type ConformanceTarget,
  type ConformanceTargetContext,
} from "../src/testing/index.ts";

const workerContext: ConformanceTargetContext = {
  name: "unit-target",
  profile: observabilityProfiles.worker,
  environment: "test",
  topology: "local",
  capabilities: { traces: true, metrics: true, defects: false, browserIngest: false, audit: false },
};

const passingProvider = (id: ConformanceCheckId): ConformanceEvidenceProvider =>
  defineConformanceEvidenceProvider({
    id,
    owner: "application",
    verify: () =>
      Effect.succeed({
        owner: "application",
        receiptType: "fixture",
        receiptId: id,
        summary: "fixture evidence",
      }),
  });

const workerProviders = (): ReadonlyArray<ConformanceEvidenceProvider> =>
  conformanceChecks
    .filter((check) => check.applies(workerContext))
    .map((check) => passingProvider(check.id));

const targetWith = (
  overrides: Partial<ConformanceTarget>,
): ConformanceTarget => ({
  name: "unit-target",
  profile: "worker",
  environment: "test",
  topology: "local",
  capabilities: { traces: true, metrics: true, defects: false, browserIngest: false, audit: false },
  providers: workerProviders(),
  ...overrides,
});

const suiteError = (exit: Exit.Exit<unknown, InvalidConformanceSuite>): string => {
  if (exit._tag !== "Failure") return "success";
  const error = Cause.squash(exit.cause);
  return error instanceof InvalidConformanceSuite ? error.code : "unknown";
};

describe("conformance suite", () => {
  it("registers every stable check with a unique id, code, and rule reference", () => {
    const ids = conformanceChecks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "profile.official",
      "identity.canonical",
      "contract.compiles",
      "manifest.valid",
      "producers.contract-derived",
      "queries.contract-derived",
      "correlation.canonical",
      "policy.compiles",
      "server-events.evlog-collector",
      "sentry.unexpected-defects-only",
      "lifecycle.profile-compliant",
      "audit.durable-before-operational",
      "pipeline.no-application-otlp",
      "canary.telemetry-destination",
      "canary.sentry",
      "canary.browser-route",
      "canary.audit",
    ]);
    for (const check of conformanceChecks) {
      expect(check.rule.document).toMatch(/^docs\//);
      expect(check.rule.heading.length).toBeGreaterThan(0);
      expect(conformanceFailureCodes).toContain(check.code);
    }
  });

  it("passes a complete worker target and keeps not-applicable checks visible", async () => {
    const report = await Effect.runPromise(runConformance(targetWith({})));
    expect(report.conforms).toBe(true);
    expect(
      report.checks.filter((check) => check.status === "not-applicable").map((check) => check.id),
    ).toEqual([
      "sentry.unexpected-defects-only",
      "audit.durable-before-operational",
      "canary.sentry",
      "canary.browser-route",
      "canary.audit",
    ]);
  });

  it("fails a target whose applicable provider is missing", async () => {
    const providers = workerProviders().slice(0, -1);
    const failure = await Effect.runPromiseExit(runConformance(targetWith({ providers })));
    expect(suiteError(failure)).toBe("OBS_CONFORMANCE_PROVIDER_MISSING");
  });

  it("rejects duplicate providers and contradictory capability selections", async () => {
    const first = workerProviders()[0];
    if (first === undefined) throw new Error("Expected worker providers.");
    const duplicated = [...workerProviders(), first];
    const duplicateFailure = await Effect.runPromiseExit(
      runConformance(targetWith({ providers: duplicated })),
    );
    expect(suiteError(duplicateFailure)).toBe("OBS_CONFORMANCE_PROVIDER_DUPLICATE");

    const browserFailure = await Effect.runPromiseExit(
      runConformance(
        targetWith({
          capabilities: { traces: true, metrics: true, defects: false, browserIngest: true, audit: false },
        }),
      ),
    );
    expect(suiteError(browserFailure)).toBe("OBS_CONFORMANCE_TARGET_INVALID");

    const reactMissingIngest = await Effect.runPromiseExit(
      runConformance(
        targetWith({
          profile: "react-web",
          capabilities: { traces: false, metrics: false, defects: false, browserIngest: false, audit: false },
          providers: [],
        }),
      ),
    );
    expect(suiteError(reactMissingIngest)).toBe("OBS_CONFORMANCE_TARGET_INVALID");
  });

  it("names the failing rule, offending value, profile, and source rule reference", async () => {
    const failing = defineConformanceEvidenceProvider({
      id: "profile.official",
      owner: "application",
      verify: () =>
        Effect.fail({
          message: "Profile sparkle is not official.",
          offendingValue: "sparkle",
        }),
    });
    const report = await Effect.runPromise(
      runConformance(
        targetWith({ providers: [failing, ...workerProviders().slice(1)] }),
      ),
    );
    expect(report.conforms).toBe(false);
    const failed = report.checks.find((check) => check.status === "fail");
    if (failed?.status !== "fail") throw new Error("Expected a failing check.");
    expect(failed.failure.code).toBe("OBS_CONFORMANCE_PROFILE_INVALID");
    expect(failed.failure.profile).toBe("worker");
    expect(failed.failure.offendingValue).toBe("sparkle");
    expect(failed.failure.rule).toEqual({
      document: "docs/profiles.md",
      heading: "Perfis oficiais de observabilidade",
    });
    const assertion = await Effect.runPromiseExit(assertConforms(report));
    expect(assertion._tag).toBe("Failure");
  });

  it("groups a suite by profile and rejects duplicate profiles", async () => {
    const report = await Effect.runPromise(
      runConformanceSuite([
        targetWith({ name: "one" }),
        targetWith({
          name: "two",
          profile: "library",
          capabilities: { traces: false, metrics: false, defects: false, browserIngest: false, audit: false },
          providers: [
            profileConformance({
              profile: "library",
              service: { name: "fixture-library", version: "1.0.0", environment: "test" },
            }),
            passingProvider("contract.compiles"),
            libraryLifecycleConformance({ runtimeMarkers: [] }),
            passingProvider("pipeline.no-application-otlp"),
          ],
        }),
      ]),
    );
    expect(report.version).toBe(1);
    expect(report.profiles.map((entry) => entry.profile)).toEqual(["worker", "library"]);
    const duplicated = await Effect.runPromiseExit(
      runConformanceSuite([targetWith({ name: "one" }), targetWith({ name: "two" })]),
    );
    expect(suiteError(duplicated)).toBe("OBS_CONFORMANCE_TARGET_INVALID");
  });

  it("proves lifecycle evidence providers reject degraded and polluted runtimes", async () => {
    const degraded = lifecycleConformance({
      report: {
        operation: "close",
        outcomes: [
          {
            participant: "adapter",
            adapter: "evlog" as never,
            capability: "events" as never,
            stage: "server" as never,
            result: { kind: "deadline-exceeded", budgetMillis: 500 },
          },
        ],
        durationMillis: 10,
        degraded: true,
      },
    });
    const outcome = await Effect.runPromiseExit(degraded.verify(workerContext));
    expect(outcome._tag).toBe("Failure");
    const polluted = libraryLifecycleConformance({ runtimeMarkers: ["react-host"] });
    const pollutedOutcome = await Effect.runPromiseExit(polluted.verify(workerContext));
    expect(pollutedOutcome._tag).toBe("Failure");
  });

  it("keeps the conformance core free of owner imports and second implementations", async () => {
    const directory = join(import.meta.dirname, "..", "src", "testing", "conformance");
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const source = await readFile(join(directory, file), "utf8");
      for (const forbidden of [
        "@equipe-tech/observability-cli",
        "@equipe-tech/observability-evlog",
        "@equipe-tech/observability-nestjs",
        "@equipe-tech/observability-sentry",
        "@equipe-tech/observability-react",
        "yuku-parser",
        "from \"yaml",
        "from \"evlog",
        "@sentry/",
        "@nestjs/",
      ]) {
        expect(source, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
