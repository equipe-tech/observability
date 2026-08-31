import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AuditAction,
  AuditDigest,
  AuditHash,
  AuditOccurredAt,
  AuditPublisher,
  canonicalAuditPayload,
  commitAuditRecord,
  defineTelemetryContract,
  InvalidAuditRecord,
  parseAuditRecord,
  recordAudit,
  unboundAuditPublisher,
  type AuditActorId,
  type AuditRecordInput,
} from "../src/index.ts";
import { layerNodeAuditDigest } from "../src/node/index.ts";

const contractEffect = defineTelemetryContract({
  version: 1,
  events: {},
  metrics: {},
  auditActions: {
    InvoiceRefunded: {
      action: "invoice.refunded",
      resourceType: "invoice",
      allowedOutcomes: ["success", "failure", "denied"],
      reasonCodes: ["approval.missing", "policy.limit_exceeded"],
    },
  },
});

const input = {
  recordId: "audit-1",
  action: "invoice.refunded",
  actor: { kind: "user", id: "user-1" },
  resource: { id: "invoice-1" },
  outcome: "denied",
  reasonCode: "approval.missing",
  tenantId: "tenant-1",
  occurredAt: "2026-01-02T03:04:05.000Z",
} satisfies AuditRecordInput;

const parsedRecord = Effect.gen(function* () {
  const contract = yield* contractEffect;
  return yield* parseAuditRecord(contract, input);
});

describe("audit contracts", () => {
  it("uses the contract action grammar for the branded action", () => {
    for (const action of ["a.b", `a.${"b".repeat(126)}`]) {
      expect(Schema.is(AuditAction)(action)).toBe(true);
    }
    for (const action of ["ab", "a.B", "a-b", `a.${"b".repeat(127)}`]) {
      expect(Schema.is(AuditAction)(action)).toBe(false);
    }
  });

  it("binds action-owned resource, outcome, reason, and immutable snapshots", async () => {
    const record = await Effect.runPromise(parsedRecord);
    expect(record.resource.type).toBe("invoice");
    if (record.actor.kind === "system") throw new Error("Expected a user actor.");
    const actorId: AuditActorId = record.actor.id;
    expect(actorId).toBe("user-1");
    expect(Option.getOrUndefined(record.reasonCode)).toBe("approval.missing");
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.actor)).toBe(true);
    expect(Object.isFrozen(record.resource)).toBe(true);
  });

  it("returns distinct typed parse failures", async () => {
    const contract = await Effect.runPromise(contractEffect);
    const cases: ReadonlyArray<readonly [AuditRecordInput, InvalidAuditRecord["code"]]> = [
      [{ ...input, action: "invoice.unknown" }, "OBS_AUDIT_UNKNOWN_ACTION"],
      [{ ...input, actor: { kind: "user", id: "\n" } }, "OBS_AUDIT_INVALID_ACTOR"],
      [{ ...input, resource: { id: "\n" } }, "OBS_AUDIT_INVALID_RESOURCE"],
      [{ ...input, outcome: "cancelled" }, "OBS_AUDIT_INVALID_OUTCOME"],
      [{ ...input, reasonCode: "because I said so" }, "OBS_AUDIT_UNKNOWN_REASON_CODE"],
      [{ ...input, recordId: "\n" }, "OBS_AUDIT_INVALID_FIELD"],
    ];
    for (const [candidate, code] of cases) {
      const error = await Effect.runPromise(
        parseAuditRecord(contract, candidate).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(InvalidAuditRecord);
      expect(error.code).toBe(code);
    }
  });

  it("returns truthful fixed reason-code messages", async () => {
    const contract = await Effect.runPromise(contractEffect);
    const malformed = await Effect.runPromise(
      parseAuditRecord(contract, { ...input, reasonCode: "NOT VALID" }).pipe(Effect.flip),
    );
    const undeclared = await Effect.runPromise(
      parseAuditRecord(contract, { ...input, reasonCode: "policy.other" }).pipe(Effect.flip),
    );
    expect(malformed.message).toBe(
      "Audit reason code is malformed. Use a dotted lowercase code up to 64 characters.",
    );
    expect(undeclared.message).toBe(
      "Audit reason code is not declared for this action. Use a declared reason code or omit it.",
    );
  });

  it("does not echo malformed action input", async () => {
    const contract = await Effect.runPromise(contractEffect);
    const action = `${"private".repeat(20_000)}\nforged`;
    const error = await Effect.runPromise(
      parseAuditRecord(contract, { ...input, action }).pipe(Effect.flip),
    );
    expect(error.message).toBe(
      "Audit action is malformed. Use a declared dotted lowercase action up to 128 characters.",
    );
    expect(error.action).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(action);
    expect(error.message.length).toBeLessThan(128);
  });

  it("accepts only canonical UTC occurrence timestamps", async () => {
    const contract = await Effect.runPromise(contractEffect);
    for (const occurredAt of [
      "2026-01-02",
      "2026-01-02T08:04:05.000+05:00",
      "2026-01-02T03:04:05Z",
      "2026-01-02T03:04:05.00Z",
      "2026-01-02T03:04:05.0000Z",
      "2026-02-30T03:04:05.000Z",
      "2026-01-02T03:04:05.000Z\n",
    ]) {
      const error = await Effect.runPromise(
        parseAuditRecord(contract, { ...input, occurredAt }).pipe(Effect.flip),
      );
      expect(error.code).toBe("OBS_AUDIT_INVALID_FIELD");
      expect(error.field).toBe("occurredAt");
    }
    const record = await Effect.runPromise(
      parseAuditRecord(contract, { ...input, occurredAt: "2026-01-02T03:04:05.000Z" }),
    );
    expect(record.occurredAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("isolates unbound publisher reports", async () => {
    const first = unboundAuditPublisher();
    const second = unboundAuditPublisher();
    expect(
      await Effect.runPromise(
        first.publish(
          (
            await Effect.runPromise(
              commitAuditRecord(await Effect.runPromise(parsedRecord), () => Effect.void).pipe(
                Effect.provide(layerNodeAuditDigest),
              ),
            )
          ).record,
        ),
      ),
    ).toEqual({ kind: "dropped", reason: "unbound" });
    expect(first.report().dropped).toBe(1);
    expect(first.report().reasons.unbound).toBe(1);
    expect(Option.isSome(first.report().firstDroppedAt)).toBe(true);
    expect(Option.isSome(first.report().lastDroppedAt)).toBe(true);
    expect(second.report().dropped).toBe(0);
    expect(Option.isNone(second.report().firstDroppedAt)).toBe(true);
  });

  it("does not publish when the durable write fails", async () => {
    const record = await Effect.runPromise(parsedRecord);
    let published = 0;
    const publisher = Layer.succeed(
      AuditPublisher,
      AuditPublisher.of({
        publish: () =>
          Effect.sync(() => {
            published += 1;
            return { kind: "published" };
          }),
        report: () => ({
          published,
          deduplicated: 0,
          dropped: 0,
          firstDroppedAt: Option.none(),
          lastDroppedAt: Option.none(),
          reasons: {
            unbound: 0,
            closed: 0,
            queueOverflow: 0,
            contractRejected: 0,
            policyRejected: 0,
            transport: 0,
          },
        }),
      }),
    );
    const failure = { code: "DATABASE_DOWN" };
    const error = await Effect.runPromise(
      recordAudit(record, () => Effect.fail(failure)).pipe(
        Effect.provide(layerNodeAuditDigest),
        Effect.provide(publisher),
        Effect.flip,
      ),
    );
    expect(error).toBe(failure);
    expect(published).toBe(0);
  });

  it("constructs a committed record only after the durable write", async () => {
    const record = await Effect.runPromise(parsedRecord);
    const order: Array<string> = [];
    const digest = Layer.succeed(
      AuditDigest,
      AuditDigest.of({
        hash: () =>
          Effect.sync(() => {
            order.push("digest");
            return Schema.decodeUnknownSync(AuditHash)("a".repeat(64));
          }),
      }),
    );
    const result = await Effect.runPromise(
      commitAuditRecord(record, (document) =>
        Effect.sync(() => {
          order.push(`durable:${document.committedAt}:${document.ledgerHash}`);
          return "row";
        }),
      ).pipe(Effect.provide(digest)),
    );
    expect(order[0]).toBe("digest");
    expect(order[1]).toMatch(/^durable:.*:[0-9a-f]{64}$/);
    expect(result.committed).toBe("row");
    expect(Object.isFrozen(result.record)).toBe(true);
  });

  it("keeps canonical payload and SHA-256 stable", async () => {
    const record = await Effect.runPromise(parsedRecord);
    const committedAt = Schema.decodeUnknownSync(AuditOccurredAt)("2026-01-02T03:04:06.000Z");
    const payload = canonicalAuditPayload(record, committedAt);
    const digest = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AuditDigest;
        return yield* service.hash(payload);
      }).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    expect(canonicalAuditPayload(record, committedAt)).toBe(payload);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(payload).not.toContain("email");
    expect(payload).not.toContain("metadata");
  });
});
