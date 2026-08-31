import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AuditAction,
  AuditOccurredAt,
  AuditOutbox,
  AuditOutboxClaimKey,
  AuditOutboxDocument,
  AuditOutboxFailure,
  AuditPublisher,
  commitAuditRecord,
  defineTelemetryContract,
  drainAuditOutbox,
  parseAuditRecord,
  type AuditOutboxSettlement,
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

const outboxFailure = (
  operation: AuditOutboxFailure["operation"],
  message: string,
  cause: AuditOutboxFailure["cause"],
) =>
  new AuditOutboxFailure({
    code: "OBS_AUDIT_OUTBOX_FAILED",
    operation,
    message,
    cause,
  });

describe("audit outbox port", () => {
  it("persists the supplied document, quarantines poison, and continues after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audit-outbox-"));
    const path = join(directory, "outbox.sqlite");
    try {
      let database = new Database(path);
      database.run(
        "create table audit_outbox (claim_key text primary key, document text not null, status text not null)",
      );
      const definition = await Effect.runPromise(contract);
      const record = await Effect.runPromise(
        parseAuditRecord(definition, {
          recordId: "audit-outbox-valid",
          action: "access.reviewed",
          actor: { kind: "system" },
          resource: { id: "account-1" },
          outcome: "success",
          occurredAt: "2026-01-02T03:04:05.000Z",
        }),
      );
      let suppliedDocument = "";
      await Effect.runPromise(
        commitAuditRecord(record, (document) =>
          Effect.sync(() => {
            suppliedDocument = JSON.stringify(document);
            database.run("insert into audit_outbox values ('b-valid', ?, 'pending')", [
              suppliedDocument,
            ]);
          }),
        ).pipe(Effect.provide(layerNodeAuditDigest)),
      );
      expect(
        database
          .query<{ readonly document: string }, []>(
            "select document from audit_outbox where claim_key = 'b-valid'",
          )
          .get()?.document,
      ).toBe(suppliedDocument);
      const validDocument = Schema.decodeUnknownSync(AuditOutboxDocument)(
        JSON.parse(suppliedDocument),
      );
      const poisonDocument = {
        ...validDocument,
        action: Schema.decodeUnknownSync(AuditAction)("access.changed"),
      };
      database.run("insert into audit_outbox values ('0-malformed', ?, 'pending')", [
        JSON.stringify({ privateRecordData: "must-not-leak" }),
      ]);
      database.run("insert into audit_outbox values ('a-poison', ?, 'pending')", [
        JSON.stringify(poisonDocument),
      ]);
      const timestampPoison = {
        ...validDocument,
        committedAt: Schema.decodeUnknownSync(AuditOccurredAt)("2026-01-02T03:04:06.000Z"),
      };
      database.run("insert into audit_outbox values ('aa-timestamp-poison', ?, 'pending')", [
        JSON.stringify(timestampPoison),
      ]);
      database.close();
      database = new Database(path);
      const settlements: Array<AuditOutboxSettlement> = [];
      const outboxLayer = Layer.succeed(
        AuditOutbox,
        AuditOutbox.of({
          claim: () =>
            Effect.try({
              try: () =>
                database
                  .query<{ readonly claim_key: string; readonly document: string }, []>(
                    "select claim_key, document from audit_outbox where status = 'pending' order by claim_key",
                  )
                  .all()
                  .map((row) => ({
                    claimKey: Schema.decodeUnknownSync(AuditOutboxClaimKey)(row.claim_key),
                    document: JSON.parse(row.document),
                  })),
              catch: (cause) =>
                outboxFailure("claim", "The test outbox could not claim pending records.", cause),
            }),
          settle: (claimKey, settlement) =>
            Effect.sync(() => {
              settlements.push(settlement);
              database.run("update audit_outbox set status = ? where claim_key = ?", [
                settlement.kind === "quarantined" ? "quarantined" : "settled",
                claimKey,
              ]);
            }),
        }),
      );
      const published = new Set<string>();
      const report = await Effect.runPromise(
        drainAuditOutbox(10).pipe(
          Effect.provide(outboxLayer),
          Effect.provide(publisherLayer(published)),
          Effect.provide(layerNodeAuditDigest),
        ),
      );
      expect(report).toEqual({
        claimed: 4,
        published: 1,
        deduplicated: 0,
        dropped: 0,
        quarantined: 3,
      });
      expect(JSON.stringify(report)).not.toContain("must-not-leak");
      expect(settlements).toEqual([
        { kind: "quarantined", reason: "invalid-document" },
        { kind: "quarantined", reason: "invalid-document" },
        { kind: "quarantined", reason: "invalid-document" },
        { kind: "published" },
      ]);
      expect(
        database
          .query<{ readonly claim_key: string; readonly status: string }, []>(
            "select claim_key, status from audit_outbox order by claim_key",
          )
          .all(),
      ).toEqual([
        { claim_key: "0-malformed", status: "quarantined" },
        { claim_key: "a-poison", status: "quarantined" },
        { claim_key: "aa-timestamp-poison", status: "quarantined" },
        { claim_key: "b-valid", status: "settled" },
      ]);
      database.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports claim failures without publishing", async () => {
    let publishes = 0;
    const claimFailure = outboxFailure(
      "claim",
      "The test outbox could not claim pending records.",
      "test claim failure",
    );
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
});
