import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  AuditDigest,
  commitAuditRecord,
  defineTelemetryContract,
  parseAuditRecord,
} from "../src/index.ts";

const contract = await Effect.runPromise(
  defineTelemetryContract({
    version: 1,
    events: {},
    metrics: {},
    auditActions: {
      AccessReviewed: {
        action: "access.reviewed",
        resourceType: "account",
        allowedOutcomes: ["success", "denied"],
        reasonCodes: ["approval.missing"],
      },
    },
  }),
);

const parsedRecord = () =>
  Effect.runPromise(
    parseAuditRecord(contract, {
      recordId: "audit-js-boundary",
      action: "access.reviewed",
      actor: { kind: "system" },
      resource: { id: "account-1" },
      outcome: "denied",
      reasonCode: "approval.missing",
      tenantId: "tenant-1",
      occurredAt: "2026-01-02T03:04:05.000Z",
    }),
  );

describe("audit commit JavaScript boundary", () => {
  it("rejects every forged structural field before hashing or durable write", async () => {
    const record = await parsedRecord();
    const cases = [
      ["schemaVersion", { ...record, schemaVersion: 99 }],
      ["recordId", { ...record, recordId: "bad\u0000id" }],
      ["action", { ...record, action: "NOT A VALID ACTION" }],
      ["actor", { ...record, actor: { kind: "service", id: "bad\nactor" } }],
      ["resource", { ...record, resource: { type: "NOT VALID", id: "account-1" } }],
      ["resource", { ...record, resource: { type: "account", id: "x".repeat(129) } }],
      ["outcome", { ...record, outcome: "exploded" }],
      ["reasonCode", { ...record, reasonCode: Option.some("free text") }],
      ["tenantId", { ...record, tenantId: Option.some("bad\ntenant") }],
      ["occurredAt", { ...record, occurredAt: "not-a-timestamp" }],
      [
        "correlation",
        {
          ...record,
          correlation: {
            trace: { _tag: "Traced", traceId: "bad", spanId: "bad" },
            requestId: Option.none(),
            runId: Option.none(),
          },
        },
      ],
    ];
    let hashes = 0;
    let writes = 0;
    const digest = Layer.succeed(
      AuditDigest,
      AuditDigest.of({
        hash: () =>
          Effect.sync(() => {
            hashes += 1;
            return "0".repeat(64);
          }),
      }),
    );
    for (const [field, candidate] of cases) {
      const failure = await Effect.runPromise(
        commitAuditRecord(candidate, () =>
          Effect.sync(() => {
            writes += 1;
          }),
        ).pipe(Effect.provide(digest), Effect.flip),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidAuditRecord",
        code: "OBS_AUDIT_INVALID_FIELD",
        field,
      });
    }
    expect(hashes).toBe(0);
    expect(writes).toBe(0);
  });
});
