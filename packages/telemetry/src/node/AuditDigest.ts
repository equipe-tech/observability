import { createHash } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { AuditDigest, AuditHash } from "../audit/AuditDigest.ts";

export const layerNodeAuditDigest = Layer.succeed(
  AuditDigest,
  AuditDigest.of({
    hash: (payload) =>
      Effect.sync(() =>
        Schema.decodeUnknownSync(AuditHash)(createHash("sha256").update(payload).digest("hex")),
      ),
  }),
);
