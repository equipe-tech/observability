import { Schema } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const telemetryManifestPath = "packages/telemetry/package.json";
const cliManifestPath = "packages/cli/package.json";
const manifestPaths = [telemetryManifestPath, cliManifestPath];

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc)\.\d+)?$/;

const PackageManifest = Schema.Struct({ version: Schema.NonEmptyString });
const CliManifest = Schema.Struct({
  version: Schema.NonEmptyString,
  dependencies: Schema.Struct({
    "@equipe-tech/observability": Schema.NonEmptyString,
  }),
});
const decodePackageManifest = Schema.decodeUnknownSync(PackageManifest);
const decodeCliManifest = Schema.decodeUnknownSync(CliManifest);

const usage = (): never => {
  console.error(
    "Usage: bun scripts/release.ts <patch|minor|major|x.y.z[-alpha.N|-beta.N|-rc.N]> [--dry-run]",
  );
  process.exit(1);
};

const run = async (command: Array<string>): Promise<string> => {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed.\n${stdout}${stderr}`);
  }
  return stdout.trim();
};

const bumpVersion = (current: string, request: string): string => {
  const match = versionPattern.exec(current);
  if (match === null) {
    throw new Error(`The current version ${current} is not a valid semver version.`);
  }
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`The current version ${current} is not a valid semver version.`);
  }
  if (request === "major") {
    return `${Number(major) + 1}.0.0`;
  }
  if (request === "minor") {
    return `${major}.${Number(minor) + 1}.0`;
  }
  if (request === "patch") {
    return `${major}.${minor}.${Number(patch) + 1}`;
  }
  if (!versionPattern.test(request)) {
    return usage();
  }
  return request;
};

const request = process.argv[2];
if (request === undefined) {
  usage();
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const status = await run(["git", "status", "--porcelain"]);
if (status !== "" && !dryRun) {
  throw new Error(
    "The working tree has uncommitted changes. Commit or stash them before a release.",
  );
}

const telemetryManifestContent: unknown = JSON.parse(
  await readFile(join(root, telemetryManifestPath), "utf8"),
);
const cliManifestContent: unknown = JSON.parse(await readFile(join(root, cliManifestPath), "utf8"));
const telemetryManifest = decodePackageManifest(telemetryManifestContent);
const cliManifest = decodeCliManifest(cliManifestContent);
if (telemetryManifest.version !== cliManifest.version) {
  throw new Error(
    `The package versions diverge: ${telemetryManifest.version}, ${cliManifest.version}. Align them before a release.`,
  );
}
if (cliManifest.dependencies["@equipe-tech/observability"] !== "workspace:*") {
  throw new Error(
    "The CLI dependency on @equipe-tech/observability must be workspace:* so packed releases use the matching version.",
  );
}
const current = telemetryManifest.version;

const next = bumpVersion(current, request);
const tag = `v${next}`;

const existingTag = await run(["git", "tag", "--list", tag]);
if (existingTag !== "") {
  throw new Error(`The tag ${tag} already exists.`);
}

console.log(`release: ${current} -> ${next} (${tag})${dryRun ? " [dry-run]" : ""}`);
console.log(`packed dependency: @equipe-tech/observability@${next}`);
if (dryRun) {
  process.exit(0);
}

for (const manifestPath of manifestPaths) {
  const absolute = join(root, manifestPath);
  const content = await readFile(absolute, "utf8");
  const updated = content.replace(`"version": "${current}"`, `"version": "${next}"`);
  if (updated === content) {
    throw new Error(`The version field was not updated in ${manifestPath}.`);
  }
  await writeFile(absolute, updated);
}

await run(["bun", "install"]);
await run(["git", "add", ...manifestPaths, "bun.lock"]);
await run(["git", "commit", "-m", `chore: release ${tag}`]);
await run(["git", "tag", "-a", tag, "-m", `Release ${next}`]);

console.log(`Created commit and tag ${tag}.`);
console.log("Publish with: git push origin master --follow-tags");
