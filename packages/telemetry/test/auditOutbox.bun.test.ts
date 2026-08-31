import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AuditOutbox,
  AuditOutboxDocument,
  AuditOutboxFailure,
  AuditPublisher,
  commitAuditRecord,
  defineTelemetryContract,
  drainAuditOutbox,
  encodeAuditOutboxDocument,
  parseAuditRecord,
  type AuditPublishReceipt,
} from "../src/index.ts";
import { layerNodeAuditDigest } from "../src/node/index.ts";

const contract = defineTelemetryContract({
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
});

const publisherLayer = (published: Set<string>) =>
  Layer.succeed(
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

describe("audit outbox port", () => {
  it("reloads plain sqlite rows after restart and retries settlement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audit-outbox-"));
    const path = join(directory, "outbox.sqlite");
    try {
      let database = new Database(path);
      database.run(
        "create table audit_outbox (record_id text primary key, document text not null, status text not null)",
      );
      const definition = await Effect.runPromise(contract);
      const record = await Effect.runPromise(
        parseAuditRecord(definition, {
          recordId: "audit-outbox-1",
          action: "access.reviewed",
          actor: { kind: "system" },
          resource: { id: "account-1" },
          outcome: "success",
          occurredAt: "2026-01-02T03:04:05.000Z",
        }),
      );
      const committed = await Effect.runPromise(
        commitAuditRecord(record, Effect.succeed("ledger-row")).pipe(
          Effect.provide(layerNodeAuditDigest),
        ),
      );
      const document = encodeAuditOutboxDocument(committed.record);
      database.run("insert into audit_outbox values (?, ?, 'pending')", [
        record.recordId,
        JSON.stringify(document),
      ]);
      database.close();
      database = new Database(path);
      let failSettle = true;
      const outboxLayer = Layer.succeed(
        AuditOutbox,
        AuditOutbox.of({
          claim: () =>
            Effect.try({
              try: () =>
                database
                  .query<{ readonly document: string }, []>(
                    "select document from audit_outbox where status = 'pending' order by record_id",
                  )
                  .all()
                  .map((row) => ({
                    record: Schema.decodeUnknownSync(AuditOutboxDocument)(JSON.parse(row.document)),
                  })),
              catch: (cause) =>
                new AuditOutboxFailure({
                  code: "OBS_AUDIT_OUTBOX_FAILED",
                  message: "The test outbox could not claim pending records.",
                  operation: "claim",
                  cause,
                }),
            }),
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
      const runDrain = drainAuditOutbox(10).pipe(
        Effect.provide(outboxLayer),
        Effect.provide(publisherLayer(published)),
        Effect.provide(layerNodeAuditDigest),
      );
      const failure = await Effect.runPromise(runDrain.pipe(Effect.flip));
      expect(failure.operation).toBe("settle");
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports claim failures without publishing", async () => {
    let publishes = 0;
    const claimFailure = new AuditOutboxFailure({
      code: "OBS_AUDIT_OUTBOX_FAILED",
      message: "The test outbox could not claim pending records.",
      operation: "claim",
      cause: "test claim failure",
    });
    const outbox = Layer.succeed(
      AuditOutbox,
      AuditOutbox.of({ claim: () => Effect.fail(claimFailure), settle: () => Effect.void }),
    );
    const publisher = Layer.succeed(
      AuditPublisher,
      AuditPublisher.of({
        publish: () =>
          Effect.sync(() => {
            publishes += 1;
            return { kind: "published" };
          }),
        report: () => ({
          published: 0,
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
    const failure = await Effect.runPromise(
      drainAuditOutbox(1).pipe(
        Effect.provide(outbox),
        Effect.provide(publisher),
        Effect.provide(layerNodeAuditDigest),
        Effect.flip,
      ),
    );
    expect(failure).toBe(claimFailure);
    expect(publishes).toBe(0);
  });

  it("rejects tampered documents before publishing", async () => {
    const definition = await Effect.runPromise(contract);
    const record = await Effect.runPromise(
      parseAuditRecord(definition, {
        recordId: "audit-outbox-tampered",
        action: "access.reviewed",
        actor: { kind: "system" },
        resource: { id: "account-1" },
        outcome: "success",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const committed = await Effect.runPromise(
      commitAuditRecord(record, Effect.void).pipe(Effect.provide(layerNodeAuditDigest)),
    );
    const document = { ...encodeAuditOutboxDocument(committed.record), action: "access.changed" };
    let publishes = 0;
    const outbox = Layer.succeed(
      AuditOutbox,
      AuditOutbox.of({
        claim: () =>
          Effect.succeed([{ record: Schema.decodeUnknownSync(AuditOutboxDocument)(document) }]),
        settle: () => Effect.void,
      }),
    );
    const publisher = Layer.succeed(
      AuditPublisher,
      AuditPublisher.of({
        publish: () =>
          Effect.sync(() => {
            publishes += 1;
            return { kind: "published" };
          }),
        report: () => ({
          published: 0,
          deduplicated: 0,
          dropped: 0,
          firstDroppedAt: Option.none(),
          lastDroppedAt: Option.none(),
          reasons: { unbound: 0, closed: 0, queueOverflow: 0, policyRejected: 0, transport: 0 },
        }),
      }),
    );
    const failure = await Effect.runPromise(
      drainAuditOutbox(1).pipe(
        Effect.provide(outbox),
        Effect.provide(publisher),
        Effect.provide(layerNodeAuditDigest),
        Effect.flip,
      ),
    );
    expect(failure.operation).toBe("parse");
    expect(publishes).toBe(0);

    const validDocument = encodeAuditOutboxDocument(committed.record);
    let settledReceipt: AuditPublishReceipt | undefined;
    const validOutbox = Layer.succeed(
      AuditOutbox,
      AuditOutbox.of({
        claim: () => Effect.succeed([{ record: validDocument }]),
        settle: (_recordId, receipt) =>
          Effect.sync(() => {
            settledReceipt = receipt;
          }),
      }),
    );
    const droppedPublisher = Layer.succeed(
      AuditPublisher,
      AuditPublisher.of({
        publish: () => Effect.succeed({ kind: "dropped", reason: "transport" }),
        report: () => ({
          published: 0,
          deduplicated: 0,
          dropped: 1,
          firstDroppedAt: Option.some("2026-01-02T03:04:05.000Z"),
          lastDroppedAt: Option.some("2026-01-02T03:04:05.000Z"),
          reasons: {
            unbound: 0,
            closed: 0,
            queueOverflow: 0,
            policyRejected: 0,
            transport: 1,
          },
        }),
      }),
    );
    const dropped = await Effect.runPromise(
      drainAuditOutbox(1).pipe(
        Effect.provide(validOutbox),
        Effect.provide(droppedPublisher),
        Effect.provide(layerNodeAuditDigest),
      ),
    );
    expect(dropped).toEqual({ claimed: 1, published: 0, deduplicated: 0, dropped: 1 });
    expect(settledReceipt).toEqual({ kind: "dropped", reason: "transport" });

    settledReceipt = undefined;
    const failedPublisher = Layer.succeed(
      AuditPublisher,
      AuditPublisher.of({
        publish: () => Effect.die("test publish failure"),
        report: () => ({
          published: 0,
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
    const publishFailure = await Effect.runPromise(
      drainAuditOutbox(1).pipe(
        Effect.provide(validOutbox),
        Effect.provide(failedPublisher),
        Effect.provide(layerNodeAuditDigest),
        Effect.flip,
      ),
    );
    expect(publishFailure.operation).toBe("publish");
    expect(settledReceipt).toBeUndefined();
  });
});
