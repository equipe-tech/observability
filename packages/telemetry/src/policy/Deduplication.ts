import type { DefectEnvelope } from "./DefectEnvelope.ts";

export type DedupeDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "deduplicated"; readonly reason: "identity" | "fingerprint" };

export type DefectDeduplicator = {
  readonly admit: (eventId: string, envelope: DefectEnvelope, now: number) => DedupeDecision;
  readonly rollback: (eventId: string) => void;
  readonly release: (eventId: string) => void;
  readonly retainedEnvelopeCount: () => number;
};

type Reservation = {
  readonly envelope: DefectEnvelope;
  readonly fingerprint: string;
};

type FingerprintReservation = {
  readonly eventId: string;
  readonly admittedAt: number;
};

const normalizedFingerprint = (envelope: DefectEnvelope): string =>
  JSON.stringify(
    envelope.fingerprint.map((part) =>
      part
        .toLowerCase()
        .replaceAll(/[?#].*$/g, "")
        .replaceAll(/\b[0-9a-f]{8,}\b/g, "<hash>")
        .replaceAll(/\d{4,}/g, "<number>"),
    ),
  );

export const defectDeduplicator = (windowMillis: number, capacity: number): DefectDeduplicator => {
  const identities = new WeakSet<DefectEnvelope>();
  const fingerprints = new Map<string, FingerprintReservation>();
  const reservations = new Map<string, Reservation>();
  return {
    admit: (eventId, envelope, now) => {
      if (identities.has(envelope)) return { kind: "deduplicated", reason: "identity" };
      const fingerprint = normalizedFingerprint(envelope);
      const previous = fingerprints.get(fingerprint);
      if (previous !== undefined && now - previous.admittedAt <= windowMillis) {
        return { kind: "deduplicated", reason: "fingerprint" };
      }
      identities.add(envelope);
      fingerprints.delete(fingerprint);
      fingerprints.set(fingerprint, { eventId, admittedAt: now });
      reservations.set(eventId, { envelope, fingerprint });
      while (fingerprints.size > capacity) {
        const oldest = fingerprints.keys().next().value;
        if (oldest !== undefined) fingerprints.delete(oldest);
      }
      return { kind: "admitted" };
    },
    rollback: (eventId) => {
      const reservation = reservations.get(eventId);
      if (reservation === undefined) return;
      reservations.delete(eventId);
      identities.delete(reservation.envelope);
      if (fingerprints.get(reservation.fingerprint)?.eventId === eventId) {
        fingerprints.delete(reservation.fingerprint);
      }
    },
    release: (eventId) => {
      reservations.delete(eventId);
    },
    retainedEnvelopeCount: () => reservations.size,
  };
};
