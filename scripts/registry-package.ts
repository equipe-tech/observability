import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { Schema } from "effect";

export type RegistryPackageReference = {
  readonly name: string;
  readonly version: string;
};

export type RegistryPackageArtifact = RegistryPackageReference & {
  readonly tarball: string;
  readonly integrity: string;
};

export type RegistryPackageFetchFailureKind =
  | "network-unavailable"
  | "registry-response-invalid"
  | "tarball-invalid";

export class RegistryPackageFetchError extends Error {
  readonly kind: RegistryPackageFetchFailureKind;

  constructor(kind: RegistryPackageFetchFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryPackageFetchError";
    this.kind = kind;
  }
}

type RegistryTarEntry = {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly content: Uint8Array;
};

const PackumentVersionDocument = Schema.Struct({
  dist: Schema.Struct({
    tarball: Schema.String,
    integrity: Schema.String,
  }),
});

const decodePackumentVersion = Schema.decodeUnknownSync(PackumentVersionDocument, {
  onExcessProperty: "preserve",
});

const maximumTarballBytes = 50 * 1024 * 1024;
const maximumExpandedBytes = 250 * 1024 * 1024;

const tarText = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("utf8").replace(/\0.*$/s, "");

const tarOctal = (bytes: Uint8Array, field: string): number => {
  const value = tarText(bytes).trim();
  if (!/^[0-7]+$/.test(value))
    throw new RegistryPackageFetchError("tarball-invalid", `Registry tar ${field} is invalid.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RegistryPackageFetchError("tarball-invalid", `Registry tar ${field} is invalid.`);
  return parsed;
};

const tarChecksum = (header: Uint8Array): number => {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1)
    checksum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  return checksum;
};

const registryRelativePath = (entryPath: string): string => {
  if (
    entryPath.length === 0 ||
    entryPath.startsWith("/") ||
    entryPath.includes("\\") ||
    !entryPath.startsWith("package/")
  )
    throw new RegistryPackageFetchError("tarball-invalid", "Registry tar entry path is unsafe.");
  const relative = entryPath.slice("package/".length);
  const normalized = posix.normalize(relative);
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  )
    throw new RegistryPackageFetchError("tarball-invalid", "Registry tar entry path is unsafe.");
  return normalized;
};

export const parseRegistryTarball = (compressed: Uint8Array): ReadonlyArray<RegistryTarEntry> => {
  if (compressed.byteLength === 0 || compressed.byteLength > maximumTarballBytes)
    throw new RegistryPackageFetchError("tarball-invalid", "Registry tarball size is invalid.");
  let archive: Uint8Array;
  try {
    archive = gunzipSync(compressed);
  } catch (cause) {
    throw new RegistryPackageFetchError(
      "tarball-invalid",
      "Registry tarball is not valid gzip data.",
      { cause },
    );
  }
  if (archive.byteLength > maximumExpandedBytes)
    throw new RegistryPackageFetchError(
      "tarball-invalid",
      "Registry tarball expands past the limit.",
    );
  const entries: Array<RegistryTarEntry> = [];
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return entries;
    const expectedChecksum = tarOctal(header.subarray(148, 156), "checksum");
    if (tarChecksum(header) !== expectedChecksum)
      throw new RegistryPackageFetchError("tarball-invalid", "Registry tar checksum is invalid.");
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const entryPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const path = registryRelativePath(entryPath);
    const size = tarOctal(header.subarray(124, 136), "entry size");
    const typeFlag = header[156] ?? 0;
    const type =
      typeFlag === 0 || typeFlag === 48 ? "file" : typeFlag === 53 ? "directory" : undefined;
    if (type === undefined)
      throw new RegistryPackageFetchError(
        "tarball-invalid",
        "Registry tar links and special entries are not allowed.",
      );
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.byteLength)
      throw new RegistryPackageFetchError("tarball-invalid", "Registry tar entry is truncated.");
    if (type === "directory" && size !== 0)
      throw new RegistryPackageFetchError("tarball-invalid", "Registry tar directory is invalid.");
    entries.push({ path, type, content: archive.subarray(contentStart, contentEnd) });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new RegistryPackageFetchError("tarball-invalid", "Registry tarball has no terminator.");
};

export const extractRegistryTarball = (compressed: Uint8Array, destination: string): void => {
  const root = resolve(destination);
  for (const entry of parseRegistryTarball(compressed)) {
    const target = resolve(root, entry.path);
    if (!target.startsWith(`${root}${sep}`))
      throw new RegistryPackageFetchError(
        "tarball-invalid",
        "Registry tar entry escaped extraction.",
      );
    if (entry.type === "directory") {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.content);
    }
  }
};

const fetchRegistryResource = async (url: string): Promise<Response> => {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (cause) {
    throw new RegistryPackageFetchError(
      "network-unavailable",
      `Registry network request failed for ${url}.`,
      { cause },
    );
  }
};

export const fetchRegistryPackage = async (
  reference: RegistryPackageReference,
  destination: string,
): Promise<RegistryPackageArtifact> => {
  const registryPath = encodeURIComponent(reference.name);
  const metadataUrl = `https://registry.npmjs.org/${registryPath}/${reference.version}`;
  const metadataResponse = await fetchRegistryResource(metadataUrl);
  if (!metadataResponse.ok)
    throw new RegistryPackageFetchError(
      "registry-response-invalid",
      `Registry metadata returned HTTP ${metadataResponse.status} for ${reference.name}@${reference.version}.`,
    );
  let metadataContent: string;
  try {
    metadataContent = await metadataResponse.text();
  } catch (cause) {
    throw new RegistryPackageFetchError(
      "network-unavailable",
      `Registry metadata download failed for ${reference.name}@${reference.version}.`,
      { cause },
    );
  }
  let metadata: typeof PackumentVersionDocument.Type;
  try {
    metadata = decodePackumentVersion(JSON.parse(metadataContent));
  } catch (cause) {
    throw new RegistryPackageFetchError(
      "registry-response-invalid",
      `Registry metadata is invalid for ${reference.name}@${reference.version}.`,
      { cause },
    );
  }
  const tarballResponse = await fetchRegistryResource(metadata.dist.tarball);
  if (!tarballResponse.ok)
    throw new RegistryPackageFetchError(
      "registry-response-invalid",
      `Registry tarball returned HTTP ${tarballResponse.status} for ${reference.name}@${reference.version}.`,
    );
  let compressed: Uint8Array;
  try {
    compressed = new Uint8Array(await tarballResponse.arrayBuffer());
  } catch (cause) {
    throw new RegistryPackageFetchError(
      "network-unavailable",
      `Registry tarball download failed for ${reference.name}@${reference.version}.`,
      { cause },
    );
  }
  const digest = createHash("sha512").update(compressed).digest("base64");
  if (metadata.dist.integrity !== `sha512-${digest}`)
    throw new RegistryPackageFetchError(
      "tarball-invalid",
      `Registry tarball integrity failed for ${reference.name}@${reference.version}.`,
    );
  extractRegistryTarball(compressed, destination);
  return { ...reference, tarball: metadata.dist.tarball, integrity: metadata.dist.integrity };
};
