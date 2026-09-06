import { expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  defineTelemetryContract,
  makeEventProducer,
  unexpectedDefect,
} from "@equipe-tech/observability";
import type { NodeObservability } from "@equipe-tech/observability/node";
import { createBrowserSentryDefectReporter } from "@equipe-tech/observability-sentry/browser";
import { sentryUnexpectedDefectsConformance } from "@equipe-tech/observability-sentry/testing";
import { evlogConformance } from "@equipe-tech/observability-evlog/testing";
import { operationsManifestConformance } from "@equipe-tech/observability-cli/testing";
import {
  applicationDeployedTelemetryDestinationReceipt,
  auditConformance,
  contractConformance,
  identityConformance,
  lifecycleConformance,
  makeCollectingTelemetryEventSink,
  producersConformance,
  telemetryCanaryConformance,
  type ConformanceTargetContext,
  type TelemetryDestinationReceipt,
} from "@equipe-tech/observability/testing";
import { observabilityProfiles } from "../../packages/telemetry/src/profile/ObservabilityProfile.ts";
import { startOtlpCaptureServer } from "@equipe-tech/observability/testing";
import {
  buildWorkerTarget,
  workerContractInput,
} from "../../observability/conformance/fixtures/positive/worker/kit.ts";
import { startLocalCollector } from "../../observability/conformance/support/collector.ts";
import { parseFixtureManifest } from "../../observability/conformance/support/manifest.ts";
import { buildCliKit } from "../../observability/conformance/fixtures/positive/cli/kit.ts";
import {
  buildNestjsKit,
  buildNestjsConformance,
} from "../../observability/conformance/fixtures/positive/nestjs-api/kit.ts";

const requiredDestinationReceipt = (receipt: TelemetryDestinationReceipt | undefined) => {
  if (receipt === undefined) {
    throw new Error("The owner Collector did not issue a destination assessment.");
  }
  return receipt;
};

const context: ConformanceTargetContext = {
  name: "fixture-worker",
  profile: observabilityProfiles.worker,
  environment: "test",
  topology: "local",
  capabilities: { traces: true, metrics: true, defects: true, browserIngest: false, audit: true },
  binding: {
    identity: { serviceName: "fixture-worker", serviceVersion: "1.0.0", environment: "test" },
    contract: {
      index: 1,
      contractVersion: 1,
      service: "fixture-worker",
      events: [],
      metrics: [],
      aliases: [],
    },
    producerContractProvenance: "{}",
  },
};

test("disabled owner Sentry outcomes cannot satisfy unexpected capture evidence", async () => {
  const reporter = createBrowserSentryDefectReporter({
    disabled: true,
    service: { name: "fixture-worker", version: "1.0.0", environment: "test" },
    policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
  });
  try {
    const outcome = reporter.capture({
      envelope: unexpectedDefect({ error: new Error("unexpected regression"), code: "APP_DEFECT" }),
    });
    expect(outcome).toEqual({ kind: "suppressed", reason: "disabled" });
    const result = await Effect.runPromiseExit(
      sentryUnexpectedDefectsConformance({
        expectedCodes: [],
        unexpectedCount: 1,
        captures: [{ code: "APP_DEFECT", outcome }],
      }).verify(context),
    );
    expect(result._tag).toBe("Failure");
  } finally {
    await reporter.dispose();
  }
});

test("every non-queued Sentry outcome fails unexpected delivery evidence", async () => {
  for (const outcome of [
    { kind: "failed", reason: "transport" },
    { kind: "suppressed", reason: "policy" },
    { kind: "suppressed", reason: "closed" },
    { kind: "deduplicated", reason: "identity" },
  ] as const) {
    const result = await Effect.runPromiseExit(
      sentryUnexpectedDefectsConformance({
        expectedCodes: [],
        unexpectedCount: 1,
        captures: [{ code: "APP_DEFECT", outcome }],
      }).verify(context),
    );
    expect(result._tag).toBe("Failure");
  }
  const queued = { kind: "queued", eventId: "event-1" } as const;
  expect(
    (
      await Effect.runPromiseExit(
        sentryUnexpectedDefectsConformance({
          expectedCodes: [],
          unexpectedCount: 1,
          captures: [{ code: "APP_DEFECT", outcome: queued }],
        }).verify(context),
      )
    )._tag,
  ).toBe("Success");
  expect(
    (
      await Effect.runPromiseExit(
        sentryUnexpectedDefectsConformance({
          expectedCodes: ["APP_EXPECTED"],
          unexpectedCount: 0,
          captures: [{ code: "APP_EXPECTED", outcome: queued }],
        }).verify(context),
      )
    )._tag,
  ).toBe("Failure");
});

test("durable owner receipts must match both requested action and record", async () => {
  const { kit } = await buildNestjsConformance();
  for (const request of [
    { operationalAction: "billing.deleted", operationalRecordId: kit.commit.record.recordId },
    { operationalAction: "fixture.updated", operationalRecordId: "different-record" },
  ]) {
    const result = await Effect.runPromiseExit(
      auditConformance({ commit: kit.commit, ...request }).verify(context),
    );
    expect(result._tag).toBe("Failure");
  }
  const result = await Effect.runPromiseExit(
    auditConformance({
      commit: kit.commit,
      operationalAction: "fixture.updated",
      operationalRecordId: "fixture-audit-1",
      operationalRecord: kit.commit.record,
    }).verify(context),
  );
  expect(result._tag).toBe("Success");
});

test("collector setup finalizes every acquired receiver after filesystem failure", async () => {
  const original = process.env.TMPDIR;
  const missing = join(process.cwd(), ".verification", `missing-${crypto.randomUUID()}`);
  await rm(missing, { recursive: true, force: true });
  process.env.TMPDIR = missing;
  try {
    const outcome = await startLocalCollector().then(
      () => "started",
      () => "failed",
    );
    expect(outcome).toBe("failed");
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  }
});

test("fixture builders finalize receivers when configuration fails", async () => {
  for (const build of [buildWorkerTarget, buildCliKit, buildNestjsKit]) {
    const collector = await startOtlpCaptureServer();
    let stops = 0;
    try {
      const failure = await build({
        ...collector,
        endpoint: new URL("ftp://127.0.0.1:4318"),
        stop: async () => {
          stops += 1;
          await collector.stop();
        },
      }).then(
        () => "succeeded",
        (cause: Error) => cause.message,
      );
      expect(failure).toContain("The OTLP endpoint is invalid");
      expect(stops).toBe(1);
      const listening = await fetch(collector.endpoint).then(
        () => true,
        () => false,
      );
      expect(listening).toBe(false);
    } finally {
      await collector.stop();
    }
  }
});

test("target identity evidence rejects service, version, and environment drift", async () => {
  for (const identity of [
    { serviceName: "other", serviceVersion: "1.0.0", environment: "test" },
    { serviceName: "fixture-worker", serviceVersion: "2.0.0", environment: "test" },
    { serviceName: "fixture-worker", serviceVersion: "1.0.0", environment: "production" },
  ]) {
    const result = await Effect.runPromiseExit(identityConformance({ identity }).verify(context));
    expect(result._tag).toBe("Failure");
  }
});

test("contract, producer, manifest, and query evidence stay on the target binding", async () => {
  const collector = await startOtlpCaptureServer();
  const kit = await buildWorkerTarget(collector);
  const workerContext = { ...context, binding: kit.binding };
  expect(
    (
      await Effect.runPromiseExit(
        contractConformance({ contract: workerContractInput }).verify(workerContext),
      )
    )._tag,
  ).toBe("Success");
  const mismatchedContext = {
    ...workerContext,
    binding: {
      ...kit.binding,
      contract: {
        ...kit.binding.contract,
        events: kit.binding.contract.events.map((event) => ({ ...event, name: "other.event" })),
      },
    },
  };
  expect(
    (
      await Effect.runPromiseExit(
        contractConformance({ contract: workerContractInput }).verify(mismatchedContext),
      )
    )._tag,
  ).toBe("Failure");
  expect(
    (
      await Effect.runPromiseExit(
        producersConformance({ receipt: kit.emitReceipt }).verify(workerContext),
      )
    )._tag,
  ).toBe("Success");
  expect(
    (
      await Effect.runPromiseExit(
        producersConformance({ receipt: kit.emitReceipt }).verify(mismatchedContext),
      )
    )._tag,
  ).toBe("Failure");
  const { manifest, contract } = await parseFixtureManifest(kit.binding);
  for (const provider of operationsManifestConformance({ manifest, contract })) {
    expect((await Effect.runPromiseExit(provider.verify(workerContext)))._tag).toBe("Success");
    expect((await Effect.runPromiseExit(provider.verify(mismatchedContext)))._tag).toBe("Failure");
  }

  const foreignContract = await Effect.runPromise(
    defineTelemetryContract({
      version: 1,
      events: {
        SchedulerRun: {
          name: "scheduler.run",
          kind: "domain",
          defaultSeverity: "warn",
          mandatory: false,
          sampling: { kind: "always" },
          attributes: {
            "foreign.value": {
              classification: "internal",
              required: true,
              metricLabel: false,
            },
          },
        },
      },
      metrics: {},
      auditActions: {},
    }),
  );
  const foreignSink = await Effect.runPromise(makeCollectingTelemetryEventSink());
  const foreignReceipt = await Effect.runPromise(
    makeEventProducer(foreignContract)
      .emit("SchedulerRun", {
        outcome: "success",
        attributes: { "foreign.value": "foreign" },
      })
      .pipe(Effect.provide(foreignSink.layer)),
  );
  expect(
    (
      await Effect.runPromiseExit(
        producersConformance({ receipt: foreignReceipt }).verify(workerContext),
      )
    )._tag,
  ).toBe("Failure");

  const mutableInput = structuredClone(workerContractInput);
  Object.defineProperty(mutableInput.events.SchedulerRun, "kind", {
    configurable: true,
    value: "domain",
  });
  const compiledBeforeMutation = await Effect.runPromise(defineTelemetryContract(mutableInput));
  expect(Object.isFrozen(compiledBeforeMutation)).toBe(true);
  expect(Object.isFrozen(compiledBeforeMutation.definition)).toBe(true);
  expect(() =>
    Object.defineProperty(compiledBeforeMutation, "provenance", { value: "retargeted" }),
  ).toThrow(TypeError);
  Object.defineProperty(mutableInput.events.SchedulerRun, "kind", { value: "operation" });
  const mutableReceipt = await Effect.runPromise(
    makeEventProducer(compiledBeforeMutation)
      .emit("SchedulerRun", { outcome: "success", durationMs: 1, attributes: {} })
      .pipe(Effect.provide(foreignSink.layer)),
  );
  expect(mutableReceipt.decision).toBe("recorded");
  if (mutableReceipt.decision !== "recorded") {
    throw new Error("The mandatory mutable-contract event was unexpectedly sampled out.");
  }
  expect(mutableReceipt.event.kind).toBe("domain");
  expect(
    (
      await Effect.runPromiseExit(
        producersConformance({ receipt: mutableReceipt }).verify(workerContext),
      )
    )._tag,
  ).toBe("Failure");
  const reordered = {
    auditActions: workerContractInput.auditActions,
    metrics: workerContractInput.metrics,
    events: workerContractInput.events,
    version: workerContractInput.version,
  };
  expect(
    (
      await Effect.runPromiseExit(
        contractConformance({ contract: reordered }).verify(workerContext),
      )
    )._tag,
  ).toBe("Success");
});

test("destination evidence requires provenance, current run, identity, selected metrics, and parentage", async () => {
  const kit = await buildWorkerTarget(await startLocalCollector());
  const workerContext = { ...context, binding: kit.binding };
  const unsealedExporterCapture: TelemetryDestinationReceipt = {
    topology: "local",
    assessment: "owner-readback",
    runId: kit.runId,
    identity: kit.binding.identity,
    observationId: "pre-collector-exporter-capture",
  };
  expect(
    (
      await Effect.runPromiseExit(
        telemetryCanaryConformance({ runId: kit.runId, receipt: unsealedExporterCapture }).verify(
          workerContext,
        ),
      )
    )._tag,
  ).toBe("Failure");
  const receipt = requiredDestinationReceipt(kit.destinationReceipt);
  expect(
    (
      await Effect.runPromiseExit(
        telemetryCanaryConformance({
          runId: kit.runId,
          receipt,
          metricRunIdAttribute: "fixture.run_id",
        }).verify(workerContext),
      )
    )._tag,
  ).toBe("Success");
  expect(receipt.assessment).toBe("owner-readback");
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.identity)).toBe(true);
  expect(() => Object.defineProperty(receipt, "topology", { value: "deployed" })).toThrow(
    TypeError,
  );
  const deployed = applicationDeployedTelemetryDestinationReceipt({
    runId: kit.runId,
    identity: kit.binding.identity,
    observationId: "application-deployed-readback",
    readback: () => kit.telemetry,
  });
  expect(deployed.assessment).toBe("application-supplied-readback");
  expect(
    (
      await Effect.runPromiseExit(
        telemetryCanaryConformance({
          runId: kit.runId,
          receipt: deployed,
          metricRunIdAttribute: "fixture.run_id",
        }).verify(workerContext),
      )
    )._tag,
  ).toBe("Failure");
});

test("evlog evidence requires an actual current-run contract event capture", async () => {
  const kit = await buildWorkerTarget(await startLocalCollector());
  const workerContext = { ...context, binding: kit.binding };
  const evidence = {
    delivery: Option.getOrThrow(kit.evlog.delivery(kit.runId, "scheduler.run")),
    drops: kit.evlog.drops(),
    destination: requiredDestinationReceipt(kit.destinationReceipt),
    runId: kit.runId,
    eventName: "scheduler.run",
  };
  expect(Object.isFrozen(evidence.delivery)).toBe(true);
  expect(() => Object.defineProperty(evidence.delivery, "runId", { value: "retargeted" })).toThrow(
    TypeError,
  );
  expect((await Effect.runPromiseExit(evlogConformance(evidence).verify(workerContext)))._tag).toBe(
    "Success",
  );
  expect(
    (
      await Effect.runPromiseExit(
        evlogConformance({ ...evidence, runId: "job-never-emitted" }).verify(workerContext),
      )
    )._tag,
  ).toBe("Failure");
  const unrelated = await buildWorkerTarget(await startLocalCollector());
  expect(
    (
      await Effect.runPromiseExit(
        evlogConformance({
          ...evidence,
          delivery: Option.getOrThrow(unrelated.evlog.delivery(unrelated.runId, "scheduler.run")),
          destination: requiredDestinationReceipt(unrelated.destinationReceipt),
        }).verify(workerContext),
      )
    )._tag,
  ).toBe("Failure");
});

test("runtime and adapter resources finalize after a post-start failure", async () => {
  const collector = await startOtlpCaptureServer();
  let started: NodeObservability | undefined;
  const failure = await buildWorkerTarget(collector, {
    failAfterStart: true,
    onStarted: (handle) => {
      started = handle;
    },
  }).then(
    () => "succeeded",
    (cause: Error) => cause.message,
  );
  expect(failure).toContain("failed after runtime startup");
  expect(started).toBeDefined();
  if (started === undefined) return;
  expect(started.enabled).toBe(true);
  if (!started.enabled) return;
  const report = await started.close();
  expect(report.operation).toBe("close");
  expect(
    report.outcomes.some(
      (outcome) =>
        outcome.participant === "adapter" &&
        outcome.adapter === "evlog-events" &&
        outcome.result.kind === "completed",
    ),
  ).toBe(true);
  expect(
    report.outcomes.some(
      (outcome) =>
        outcome.participant === "runtime-disposal" && outcome.result.kind === "completed",
    ),
  ).toBe(true);
});

test("real runtime flush cannot satisfy terminal lifecycle compliance", async () => {
  const collector = await startOtlpCaptureServer();
  const kit = await buildWorkerTarget(collector, { lifecycleOperation: "flush" });
  expect(kit.lifecycleReport.operation).toBe("flush");
  const result = await Effect.runPromiseExit(
    lifecycleConformance({ report: kit.lifecycleReport }).verify(context),
  );
  expect(result._tag).toBe("Failure");
});

test("real runtime terminal disposal satisfies lifecycle compliance", async () => {
  const collector = await startOtlpCaptureServer();
  const kit = await buildWorkerTarget(collector);
  expect(kit.lifecycleReport.operation).toBe("close");
  const result = await Effect.runPromiseExit(
    lifecycleConformance({ report: kit.lifecycleReport }).verify(context),
  );
  expect(result._tag).toBe("Success");
});
