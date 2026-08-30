import { Schema } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc)\.\d+)?$/;
const Manifest = Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString });
const decodeManifest = Schema.decodeUnknownSync(Manifest);

type WorkspacePackage = {
  readonly directory: string;
  readonly manifestPath: string;
  readonly name: string;
  readonly slug: string;
  readonly version: string;
};

const usage = (): never => {
  console.error(
    "Usage: bun scripts/release.ts <patch|minor|major|x.y.z[-alpha.N|-beta.N|-rc.N]> --package <slug> [--dry-run]",
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
  if (request === "major") return `${Number(major) + 1}.0.0`;
  if (request === "minor") return `${major}.${Number(minor) + 1}.0`;
  if (request === "patch") return `${major}.${minor}.${Number(patch) + 1}`;
  if (!versionPattern.test(request)) return usage();
  return request;
};

const workspacePackages = async (): Promise<ReadonlyArray<WorkspacePackage>> => {
  const packages: Array<WorkspacePackage> = [];
  const manifests = new Bun.Glob("packages/*/package.json");
  for await (const manifestPath of manifests.scan({ cwd: root })) {
    const value: unknown = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
    const manifest = decodeManifest(value);
    packages.push({
      directory: basename(dirname(manifestPath)),
      manifestPath,
      name: manifest.name,
      slug: manifest.name.replace("@equipe-tech/", ""),
      version: manifest.version,
    });
  }
  return packages;
};

const request = process.argv[2];
const packageFlag = process.argv.indexOf("--package");
const requestedSlug = packageFlag === -1 ? undefined : process.argv[packageFlag + 1];
const releaseRequest = request ?? usage();
const releaseSlug = requestedSlug ?? usage();
const dryRun = process.argv.includes("--dry-run");
const selected = (await workspacePackages()).find((entry) => entry.slug === releaseSlug);
if (selected === undefined) {
  throw new Error(`Unknown release package ${releaseSlug}.`);
}

const status = await run(["git", "status", "--porcelain"]);
if (status !== "" && !dryRun) {
  throw new Error(
    "The working tree has uncommitted changes. Commit or stash them before a release.",
  );
}

const next = bumpVersion(selected.version, releaseRequest);
const tag = `${selected.slug}@${next}`;
const existingTag = await run(["git", "tag", "--list", tag]);
if (existingTag !== "") {
  throw new Error(`The tag ${tag} already exists.`);
}

console.log(
  `release ${selected.name}: ${selected.version} -> ${next} (${tag})${dryRun ? " [dry-run]" : ""}`,
);
if (dryRun) process.exit(0);

const absolute = join(root, selected.manifestPath);
const content = await readFile(absolute, "utf8");
const updated = content.replace(`"version": "${selected.version}"`, `"version": "${next}"`);
if (updated === content) {
  throw new Error(`The version field was not updated in ${selected.manifestPath}.`);
}
await writeFile(absolute, updated);
await run(["bun", "install"]);
await run(["git", "add", selected.manifestPath, "bun.lock"]);
await run(["git", "commit", "-m", `chore: release ${tag}`]);
await run(["git", "tag", "-a", tag, "-m", `Release ${selected.name} ${next}`]);

console.log(`Created commit and tag ${tag}.`);
console.log("Publish with: git push origin master --follow-tags");
