import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { commitAuditRecord, defineTelemetryContract, parseAuditRecord } from "../src/index.ts";
import { layerNodeAuditDigest } from "../src/node/index.ts";

describe("audit commit JavaScript boundary", () => {
  it("returns InvalidAuditRecord for an unbranded action", async () => {
    const contract = await Effect.runPromise(
      defineTelemetryContract({
        version: 1,
        events: {},
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
    const record = await Effect.runPromise(
      parseAuditRecord(contract, {
        recordId: "audit-js-boundary",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-1" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    let writes = 0;
    const failure = await Effect.runPromise(
      commitAuditRecord({ ...record, action: "NOT A VALID ACTION" }, () =>
        Effect.sync(() => {
          writes += 1;
        }),
      ).pipe(Effect.provide(layerNodeAuditDigest), Effect.flip),
    );
    expect(failure).toMatchObject({
      _tag: "InvalidAuditRecord",
      code: "OBS_AUDIT_INVALID_FIELD",
      field: "action",
    });
    expect(writes).toBe(0);
  });
});
