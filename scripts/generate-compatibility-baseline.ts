import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { currentPackageSurface, packageSurfaceDigest } from "./compatibility-gate.ts";
import { encodeCompatibilityJson } from "./compatibility-json.ts";

const tag = "v0.2.1";
const commit = "a5ab6997536f9d3af797429783f65c9e68a0dfa0";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

const requireSuccess = (result: CommandResult, action: string): void => {
  if (result.exitCode !== 0)
    throw new Error(`${action} failed: ${result.stdout.toString()}${result.stderr.toString()}`);
};

const directory = mkdtempSync(join(tmpdir(), "observability-baseline-"));
try {
  const resolved = Bun.spawnSync({ cmd: ["git", "rev-parse", `${tag}^{}`] });
  requireSuccess(resolved, "Resolving the baseline tag");
  if (resolved.stdout.toString().trim() !== commit)
    throw new Error("The baseline tag does not resolve to the pinned commit.");
  const archive = join(directory, "source.tar");
  requireSuccess(
    Bun.spawnSync({ cmd: ["git", "archive", "--format=tar", `--output=${archive}`, tag] }),
    "Archiving the baseline tag",
  );
  requireSuccess(
    Bun.spawnSync({ cmd: ["tar", "-xf", archive, "-C", directory] }),
    "Extracting the baseline tag",
  );
  for (const packageName of ["telemetry", "cli"]) {
    const packageRoot = join(directory, "packages", packageName);
    const sourceRoot = join(packageRoot, "src");
    const distributionRoot = join(packageRoot, "dist");
    for (const source of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
      if (!source.isFile() || !source.name.endsWith(".ts")) continue;
      const relative = join(source.parentPath.slice(sourceRoot.length + 1), source.name);
      const declaration = join(distributionRoot, relative.replace(/[.]ts$/, ".d.ts"));
      const runtime = declaration.replace(/[.]d[.]ts$/, ".js");
      mkdirSync(dirname(declaration), { recursive: true });
      cpSync(join(source.parentPath, source.name), declaration);
      writeFileSync(runtime, "");
    }
  }
  const packages = ["telemetry", "cli"].map((packageName) => {
    const surface = currentPackageSurface(join(directory, "packages", packageName));
    return { ...surface, surfaceDigest: packageSurfaceDigest(surface) };
  });
  const browserEvents = readFileSync(
    join(directory, "packages/telemetry/src/BrowserEvents.ts"),
    "utf8",
  );
  const eventDocument = /export class BrowserEvent[\s\S]+?\)\(\{([\s\S]+?)\}\) \{\}/.exec(
    browserEvents,
  )?.[1];
  if (eventDocument === undefined)
    throw new Error("The tagged browser event schema was not found.");
  const eventFields = [...eventDocument.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)]
    .map((match) => match[1])
    .filter((field) => field !== undefined)
    .sort();
  const baseline = {
    baseline: 1,
    source: { tag, commit },
    contract: {
      surface: 1,
      service: "observability",
      contractVersion: 1,
      events: [],
      metrics: [],
      auditActions: [],
      aliases: [],
      browserEnvelope: {
        version: 1,
        batchFields: ["events", "version"],
        eventFields,
      },
      retentionWindowDays: 30,
    },
    packages,
  };
  writeFileSync("observability/compatibility/baseline.json", encodeCompatibilityJson(baseline));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
