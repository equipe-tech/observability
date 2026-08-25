import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PackageManifest = Schema.Struct({
  version: Schema.NonEmptyString,
});

const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

const parseManifest = (): typeof PackageManifest.Type => {
  const content = readFileSync(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(content);
  return decodePackageManifest(parsed);
};

export const packageVersion = parseManifest().version;
