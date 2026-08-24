import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "observability-package-"));

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const run = (command: Array<string>, cwd: string, env = process.env): Promise<CommandResult> => {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
};

const requireSuccess = (result: CommandResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed.\n${result.stdout}${result.stderr}`);
  }
};

const assertArchive = (
  entries: string,
  required: ReadonlyArray<string>,
  forbidden: ReadonlyArray<string>,
): void => {
  for (const path of required) {
    if (!entries.includes(path)) {
      throw new Error(`The package archive does not contain ${path}.`);
    }
  }
  for (const path of forbidden) {
    if (entries.includes(path)) {
      throw new Error(`The package archive contains forbidden path ${path}.`);
    }
  }
};

try {
  requireSuccess(await run(["bun", "run", "build"], root), "The package build");

  const packages = [
    {
      directory: join(root, "packages/telemetry"),
      archive: "telemetry.tgz",
      required: ["package/dist/LICENSE", "package/dist/index.js", "package/dist/index.d.ts"],
    },
    {
      directory: join(root, "packages/cli"),
      archive: "cli.tgz",
      required: [
        "package/dist/LICENSE",
        "package/dist/main.js",
        "package/dist/main.d.ts",
        "package/dist/assets/docker-compose.yml",
        "package/dist/assets/local.yaml",
      ],
    },
  ];

  for (const packageSpec of packages) {
    requireSuccess(
      await run(
        [
          "bun",
          "pm",
          "pack",
          "--filename",
          join(temporaryDirectory, packageSpec.archive),
          "--ignore-scripts",
          "--quiet",
        ],
        packageSpec.directory,
      ),
      `Packing ${packageSpec.archive}`,
    );
    const listing = await run(
      ["tar", "-tzf", join(temporaryDirectory, packageSpec.archive)],
      temporaryDirectory,
    );
    requireSuccess(listing, `Reading ${packageSpec.archive}`);
    assertArchive(listing.stdout, packageSpec.required, ["package/src/", "package/test/"]);
  }

  const consumer = join(temporaryDirectory, "consumer outside repository");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@equipe-tech/observability": `file:${join(temporaryDirectory, "telemetry.tgz")}`,
        "@equipe-tech/observability-cli": `file:${join(temporaryDirectory, "cli.tgz")}`,
      },
    }),
  );
  requireSuccess(await run(["bun", "install"], consumer), "Installing packed packages");
  const declarations = new Bun.Glob("**/*.d.ts");
  for (const packageName of ["observability", "observability-cli"]) {
    const distribution = join(consumer, "node_modules/@equipe-tech", packageName, "dist");
    for await (const declaration of declarations.scan({ cwd: distribution })) {
      const source = await Bun.file(join(distribution, declaration)).text();
      if (/(["']\.[^"']+)\.ts(["'])/.test(source)) {
        throw new Error(`The declaration ${declaration} contains a TypeScript source specifier.`);
      }
    }
  }
  requireSuccess(
    await run(
      [
        "bun",
        "-e",
        "import { Telemetry, WideEvent } from '@equipe-tech/observability'; if (!Telemetry.layer || !WideEvent.emit) process.exit(1);",
      ],
      consumer,
    ),
    "Importing the telemetry package",
  );
  await writeFile(
    join(consumer, "index.ts"),
    "import { TelemetryConfig } from '@equipe-tech/observability';\nconst config = new TelemetryConfig({ serviceName: 'test', serviceVersion: '1.0.0', environment: 'test', otlpEndpoint: new URL('http://localhost:4318') });\nvoid config;\n",
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
      },
      include: ["index.ts"],
    }),
  );
  requireSuccess(
    await run(
      ["bun", join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      consumer,
    ),
    "Checking the telemetry declarations",
  );

  const executable = join(consumer, "node_modules/.bin/observability");
  const help = await run([executable, "--help"], consumer);
  requireSuccess(help, "Executing the packed CLI");
  if (!help.stdout.includes("Plataforma de observabilidade")) {
    throw new Error("The packed CLI did not render its help output.");
  }

  const state = join(temporaryDirectory, "writable state");
  requireSuccess(
    await run([executable, "dev", "status"], consumer, {
      ...process.env,
      OBSERVABILITY_HOME: state,
    }),
    "Executing the packed CLI outside the repository",
  );
  const copiedCompose = await readFile(join(state, "0.1.0", "docker-compose.yml"), "utf8");
  if (!copiedCompose.includes("observability-local")) {
    throw new Error("The packed CLI did not prepare the local stack assets.");
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
