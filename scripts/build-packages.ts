import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkPackageBoundaries } from "./package-boundaries.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["telemetry", "nestjs", "evlog", "sentry", "cli"];

const boundaryViolations = await checkPackageBoundaries();
if (boundaryViolations.length > 0) {
  throw new Error(
    boundaryViolations
      .map((violation) => `${violation.rule}: ${violation.file} imports ${violation.specifier}`)
      .join("\n"),
  );
}

for (const packageName of packages) {
  await rm(`${root}/packages/${packageName}/dist`, { recursive: true, force: true });
  const compiler = Bun.spawn(["bunx", "tsc", "-p", `packages/${packageName}/tsconfig.build.json`], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await compiler.exited;
  if (exitCode !== 0) {
    throw new Error(`The ${packageName} package build failed with exit code ${exitCode}.`);
  }

  const declarations = new Bun.Glob("**/*.d.ts");
  const distribution = `${root}/packages/${packageName}/dist`;
  for await (const declaration of declarations.scan({ cwd: distribution })) {
    const file = `${distribution}/${declaration}`;
    const source = await Bun.file(file).text();
    await Bun.write(file, source.replace(/(["']\.[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
  await cp(`${root}/LICENSE`, `${distribution}/LICENSE`);
}

await mkdir(`${root}/packages/cli/dist/assets`, { recursive: true });
await cp(`${root}/packages/cli/src/assets`, `${root}/packages/cli/dist/assets`, {
  recursive: true,
});
