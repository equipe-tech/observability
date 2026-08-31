import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Effect, Layer, Option } from "effect";
import {
  AuditOutbox,
  AuditOutboxFailure,
  AuditPublisher,
  commitAuditRecord,
  defineTelemetryContract,
  drainAuditOutbox,
  parseAuditRecord,
  type AuditPublishReceipt,
  type CommittedAuditRecord,
} from "../src/index.ts";
import { layerNodeAuditDigest } from "../src/node/index.ts";

describe("audit outbox port", () => {
  it("commits, claims, publishes, retries, deduplicates, and settles through test-only sqlite", async () => {
    const database = new Database(":memory:");
    database.run("create table audit_outbox (record_id text primary key, status text not null)");
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
        recordId: "audit-outbox-1",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-1" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(
        record,
        Effect.sync(() => {
          database.run("insert into audit_outbox values (?, 'pending')", [record.recordId]);
          return "ledger-row";
        }),
      ).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const records = new Map<string, CommittedAuditRecord>([
      [committed.record.recordId, committed.record],
    ]);
    let failSettle = true;
    const outboxLayer = Layer.succeed(
      AuditOutbox,
      AuditOutbox.of({
        claim: () =>
          Effect.sync(() =>
            database
              .query<{ readonly record_id: string }, []>(
                "select record_id from audit_outbox where status = 'pending' order by record_id",
              )
              .all()
              .flatMap((row) => {
                const claimed = records.get(row.record_id);
                return claimed === undefined ? [] : [{ record: claimed }];
              }),
          ),
        settle: (recordId, receipt) => {
          if (failSettle) {
            failSettle = false;
            return Effect.fail(
              new AuditOutboxFailure({
                code: "OBS_AUDIT_OUTBOX_FAILED",
                message: "The test outbox could not settle the claimed record.",
                operation: "settle",
                cause: "test settle failure",
              }),
            );
          }
          return Effect.sync(() => {
            if (receipt.kind !== "dropped") {
              database.run("update audit_outbox set status = 'settled' where record_id = ?", [
                recordId,
              ]);
            }
          });
        },
      }),
    );
    const published = new Set<string>();
    const publisherLayer = Layer.succeed(
      AuditPublisher,
      AuditPublisher.of({
        publish: (candidate) =>
          Effect.sync((): AuditPublishReceipt => {
            if (published.has(candidate.recordId)) return { kind: "deduplicated" };
            published.add(candidate.recordId);
            return { kind: "published" };
          }),
        report: () => ({
          published: published.size,
          deduplicated: 0,
          dropped: 0,
          firstDroppedAt: Option.none(),
          lastDroppedAt: Option.none(),
          reasons: {
            unbound: 0,
            closed: 0,
            queueOverflow: 0,
            policyRejected: 0,
            transport: 0,
          },
        }),
      }),
    );
    const runDrain = drainAuditOutbox(10).pipe(
      Effect.provide(outboxLayer),
      Effect.provide(publisherLayer),
    );
    const failure = await Effect.runPromise(runDrain.pipe(Effect.flip));
    expect(failure).toBeInstanceOf(AuditOutboxFailure);
    const retry = await Effect.runPromise(runDrain);
    expect(retry).toEqual({ claimed: 1, published: 0, deduplicated: 1, dropped: 0 });
    expect(
      database
        .query<{ readonly status: string }, []>(
          "select status from audit_outbox where record_id = 'audit-outbox-1'",
        )
        .get()?.status,
    ).toBe("settled");
    database.close();
  });
});
