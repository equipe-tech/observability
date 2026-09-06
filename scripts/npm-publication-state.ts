type NpmPublicationState = "missing" | "published";

type NpmViewResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export const classifyNpmView = (result: NpmViewResult): NpmPublicationState => {
  if (result.exitCode === 0) return "published";
  if (result.stderr.includes("E404") || result.stdout.includes("E404")) return "missing";
  throw new Error(
    `npm view failed with exit code ${result.exitCode}.\n${result.stdout}${result.stderr}`,
  );
};

const run = async (packageName: string, version: string): Promise<NpmPublicationState> => {
  const child = Bun.spawn(["npm", "view", `${packageName}@${version}`, "version", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return classifyNpmView({ exitCode, stdout, stderr });
};

if (import.meta.main) {
  const packageName = process.argv[2];
  const version = process.argv[3];
  if (packageName === undefined || version === undefined) {
    throw new Error("Usage: bun scripts/npm-publication-state.ts <package> <version>");
  }
  console.log(await run(packageName, version));
}
