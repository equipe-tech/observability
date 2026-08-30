import type { DefectEnvelope } from "@equipe-tech/observability/policy";

export type DedupeDecision =
  | { readonly kind: "admitted"; readonly fingerprint: string }
  | { readonly kind: "deduplicated"; readonly reason: "identity" | "fingerprint" };

export type DefectDeduplicator = {
  readonly admit: (envelope: DefectEnvelope, now: number) => DedupeDecision;
  readonly rollback: (envelope: DefectEnvelope, fingerprint: string) => void;
};

const normalizedFingerprint = (envelope: DefectEnvelope): string =>
  envelope.fingerprint
    .map((part) =>
      part
        .toLowerCase()
        .replaceAll(/[?#].*$/g, "")
        .replaceAll(/\b[0-9a-f]{8,}\b/g, "<hash>")
        .replaceAll(/\d{4,}/g, "<number>"),
    )
    .join("|");

export const defectDeduplicator = (windowMillis: number, capacity: number): DefectDeduplicator => {
  const identities = new WeakSet<DefectEnvelope>();
  const fingerprints = new Map<string, number>();
  return {
    admit: (envelope, now) => {
      if (identities.has(envelope)) return { kind: "deduplicated", reason: "identity" };
      const fingerprint = normalizedFingerprint(envelope);
      const previous = fingerprints.get(fingerprint);
      if (previous !== undefined && now - previous <= windowMillis) {
        return { kind: "deduplicated", reason: "fingerprint" };
      }
      identities.add(envelope);
      fingerprints.delete(fingerprint);
      fingerprints.set(fingerprint, now);
      while (fingerprints.size > capacity) {
        const oldest = fingerprints.keys().next().value;
        if (oldest !== undefined) fingerprints.delete(oldest);
      }
      return { kind: "admitted", fingerprint };
    },
    rollback: (envelope, fingerprint) => {
      identities.delete(envelope);
      fingerprints.delete(fingerprint);
    },
  };
};
