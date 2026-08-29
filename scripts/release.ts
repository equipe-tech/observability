import { Schema } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPaths = ["packages/telemetry/package.json", "packages/cli/package.json"];

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc)\.\d+)?$/;

const Manifest = Schema.Struct({ version: Schema.NonEmptyString });
const decodeManifest = Schema.decodeUnknownSync(Manifest);

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

const versions = new Set<string>();
for (const manifestPath of manifestPaths) {
  const content: unknown = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  versions.add(decodeManifest(content).version);
}
if (versions.size !== 1) {
  throw new Error(
    `The package versions diverge: ${[...versions].join(", ")}. Align them before a release.`,
  );
}
const [current] = [...versions];
if (current === undefined) {
  throw new Error("No package version found.");
}

const next = bumpVersion(current, request);
const tag = `v${next}`;

const existingTag = await run(["git", "tag", "--list", tag]);
if (existingTag !== "") {
  throw new Error(`The tag ${tag} already exists.`);
}

console.log(`release: ${current} -> ${next} (${tag})${dryRun ? " [dry-run]" : ""}`);
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
