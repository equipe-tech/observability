import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

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
  return stdout;
};

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];
if (tag === undefined || !tag.includes("@")) {
  console.error("Usage: bun scripts/release-notes.ts --tag <slug>@<semver>");
  process.exit(1);
}

const slug = tag.slice(0, tag.indexOf("@"));
const knownTags = (await run(["git", "tag", "--list", `${slug}@*`, "--sort=-v:refname"]))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

const previousTag = knownTags.find((candidate) => candidate !== tag);
const target = knownTags.includes(tag) ? tag : "HEAD";
const range = previousTag === undefined ? target : `${previousTag}..${target}`;

const subjects = (await run(["git", "log", range, "--no-merges", "--format=%s"]))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("chore: release "));

const sections: Array<{ readonly title: string; readonly prefixes: Array<string> }> = [
  { title: "Novidades", prefixes: ["feat"] },
  { title: "Correções", prefixes: ["fix", "perf"] },
  { title: "Outras mudanças", prefixes: [] },
];

const subjectType = (subject: string): string => {
  const match = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject);
  return match?.[1] ?? "";
};

const lines: Array<string> = [`## ${tag}`];
if (previousTag !== undefined) {
  lines.push("", `Mudanças desde ${previousTag}.`);
}

const used = new Set<string>();
for (const section of sections) {
  const entries = subjects.filter((subject) => {
    if (used.has(subject)) {
      return false;
    }
    if (section.prefixes.length === 0) {
      return true;
    }
    return section.prefixes.includes(subjectType(subject));
  });
  if (entries.length === 0) {
    continue;
  }
  lines.push("", `### ${section.title}`, "");
  for (const entry of entries) {
    lines.push(`- ${entry}`);
    used.add(entry);
  }
}

if (subjects.length === 0) {
  lines.push("", "Sem mudanças registradas.");
}

console.log(lines.join("\n"));
