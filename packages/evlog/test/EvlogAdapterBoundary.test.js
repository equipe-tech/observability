import {
  AuditPublisher,
  Contract,
  commitAuditRecord,
  defineTelemetryContract,
  parseAuditRecord,
  parseNodeObservabilityConfig,
} from "@equipe-tech/observability";
import {
  createNodeObservabilityFromConfig,
  layerNodeAuditDigest,
} from "@equipe-tech/observability/node";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { evlogAdapter } from "../src/index.ts";

const contract = await Effect.runPromise(
  defineTelemetryContract({
    version: 1,
    events: { AuditRecorded: Contract.organizationEvents.AuditRecorded },
    metrics: {},
    auditActions: {
      AccessReviewed: {
        action: "access.reviewed",
        resourceType: "account",
        allowedOutcomes: ["success"],
      },
    },
  }),
);

const config = await Effect.runPromise(
  parseNodeObservabilityConfig({
    enabled: true,
    profile: "worker",
    service: { name: "audit-boundary-test", version: "1.2.3", environment: "test" },
    telemetry: { endpoint: new URL("http://127.0.0.1:1") },
    evlog: {
      contract,
      policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
    },
    sentry: { enabled: false },
  }),
);

describe("AuditPublisher JavaScript boundary", () => {
  it("count-rejects malformed and unbranded values without reading or admitting them", async () => {
    const observability = await createNodeObservabilityFromConfig(config, [
      evlogAdapter({ installGlobalLogger: false }).registration,
    ]);
    if (!observability.enabled) throw new Error("Expected enabled observability.");
    const publisher = await Effect.runPromise(
      AuditPublisher.pipe(Effect.provide(observability.auditLayer)),
    );
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-boundary-record",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-1" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, () => Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    let getterReads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "action", {
      get() {
        getterReads += 1;
        throw new Error("hostile getter read");
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          getterReads += 1;
          throw new Error("hostile proxy read");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const candidates = [
      null,
      undefined,
      false,
      0,
      "audit",
      1n,
      Symbol("audit"),
      {},
      Object.create(null),
      { ...committed.record },
      hostile,
      hostileProxy,
      revoked.proxy,
    ];
    for (const candidate of candidates) {
      await expect(Effect.runPromise(publisher.publish(candidate))).resolves.toEqual({
        kind: "dropped",
        reason: "contract-rejected",
      });
    }
    expect(getterReads).toBe(0);
    expect(publisher.report()).toMatchObject({
      published: 0,
      deduplicated: 0,
      dropped: candidates.length,
      reasons: { contractRejected: candidates.length },
    });
    await observability.close();
  });
});
