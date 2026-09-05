import { Schema } from "effect";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const Manifest = Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString });
const decodeManifest = Schema.decodeUnknownSync(Manifest);

const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value === "") {
    throw new Error(`Missing required argument ${name}.`);
  }
  return value;
};

const run = async (command: ReadonlyArray<string>, cwd: string = root): Promise<string> => {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed.\n${stdout}${stderr}`);
  return stdout;
};

const slug = argument("--package");
const version = argument("--version");
const output = argument("--output");
const packageDirectories = new Map([
  ["observability", "telemetry"],
  ["observability-evlog", "evlog"],
  ["observability-nestjs", "nestjs"],
  ["observability-sentry", "sentry"],
  ["observability-react", "react"],
  ["observability-cli", "cli"],
]);
const packageDirectoryName = packageDirectories.get(slug);
if (packageDirectoryName === undefined) {
  throw new Error(`Unknown release package ${slug}.`);
}
const manifestPath = join(root, "packages", packageDirectoryName, "package.json");
const manifestValue: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
const manifest = decodeManifest(manifestValue);
if (manifest.name.replace("@equipe-tech/", "") !== slug) {
  throw new Error(`Unknown release package ${slug}.`);
}
if (manifest.version !== version) {
  throw new Error(`Version ${version} does not match ${manifestPath}.`);
}

const tag = `${slug}@${version}`;
const archive = `equipe-tech-${slug}-${version}.tgz`;
const packageDirectory = dirname(manifestPath);
const work = join(output, ".candidate");
await rm(output, { recursive: true, force: true });
await mkdir(join(work, "first"), { recursive: true });
await mkdir(join(work, "second"), { recursive: true });
for (const pack of ["first", "second"]) {
  await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", join(work, pack, archive)],
    packageDirectory,
  );
}
const first = new Uint8Array(await Bun.file(join(work, "first", archive)).arrayBuffer());
const second = new Uint8Array(await Bun.file(join(work, "second", archive)).arrayBuffer());
if (!first.every((byte, index) => second[index] === byte) || first.length !== second.length) {
  throw new Error(`Candidate archive ${archive} is not reproducible.`);
}
const hash = new Bun.CryptoHasher("sha256").update(first).digest("hex");
const notesPath = join(output, `${tag}.md`);
const checksumPath = join(output, `${tag}.sha256`);
await Bun.write(join(output, archive), first);
await writeFile(checksumPath, `${hash}  ${archive}\n`);
await writeFile(notesPath, await run(["bun", "scripts/release-notes.ts", "--tag", tag]));
await rm(work, { recursive: true, force: true });
