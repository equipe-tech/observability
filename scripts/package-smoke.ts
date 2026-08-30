import { Schema } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cleanupTestIndex = process.argv.indexOf("--signal-cleanup-test");
const cleanupReadyFile = cleanupTestIndex === -1 ? "" : (process.argv[cleanupTestIndex + 1] ?? "");
const cleanupScenario =
  cleanupTestIndex === -1 ? "" : (process.argv[cleanupTestIndex + 2] ?? "idle");
const requestedCleanupDeadline = Number(
  cleanupTestIndex === -1 ? "3000" : (process.argv[cleanupTestIndex + 3] ?? "3000"),
);
const cleanupDeadlineMilliseconds =
  Number.isFinite(requestedCleanupDeadline) && requestedCleanupDeadline > 0
    ? requestedCleanupDeadline
    : 3_000;
const processGroupsSupported = process.platform !== "win32";
let temporaryDirectory = "";
let cleanupStarted = false;
let cleanupResult = Promise.resolve();
let terminationRequested = false;
let terminationExitCode = 1;
const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();
let allocationPromise = Promise.resolve("");

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const run = (command: Array<string>, cwd: string, env = process.env): Promise<CommandResult> => {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: processGroupsSupported,
  });
  activeChildren.add(child);
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
    .then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }))
    .finally(() => activeChildren.delete(child));
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

const signalChild = (child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void => {
  if (processGroupsSupported) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  child.kill(signal);
};

const waitForChildren = async (
  children: ReadonlyArray<ReturnType<typeof Bun.spawn>>,
  deadline: number,
): Promise<void> => {
  while (Date.now() < deadline && children.some((child) => activeChildren.has(child))) {
    await Bun.sleep(10);
  }
};

const stopChildren = async (deadline: number): Promise<void> => {
  const children = [...activeChildren];
  for (const child of children) {
    signalChild(child, "SIGTERM");
  }
  const remaining = Math.max(0, deadline - Date.now());
  const termDeadline = Date.now() + Math.floor(remaining / 2);
  await waitForChildren(children, termDeadline);
  for (const child of children) {
    if (activeChildren.has(child)) {
      signalChild(child, "SIGKILL");
    }
  }
  await waitForChildren(children, deadline);
  activeChildren.clear();
};

const cleanupTemporaryDirectory = async (): Promise<void> => {
  try {
    temporaryDirectory = await allocationPromise;
  } catch {
    temporaryDirectory = "";
  }
  const deadline = Date.now() + cleanupDeadlineMilliseconds;
  await stopChildren(deadline);
  if (temporaryDirectory !== "") {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const cleanup = (): Promise<void> => {
  if (!cleanupStarted) {
    cleanupStarted = true;
    cleanupResult = cleanupTemporaryDirectory();
  }
  return cleanupResult;
};

const terminateAfterCleanup = (exitCode: number): void => {
  if (!terminationRequested) {
    terminationRequested = true;
    terminationExitCode = exitCode;
    cleanup().then(
      () => process.exit(terminationExitCode),
      () => process.exit(terminationExitCode),
    );
    return;
  }
  cleanup().then(
    () => undefined,
    () => undefined,
  );
};

const onSigint = (): void => terminateAfterCleanup(130);
const onSigterm = (): void => terminateAfterCleanup(143);

const allocateTemporaryDirectory = async (): Promise<string> => {
  if (cleanupScenario === "allocation") {
    if (cleanupReadyFile === "") {
      throw new Error("The allocation cleanup test requires a ready file path.");
    }
    await writeFile(cleanupReadyFile, JSON.stringify({ phase: "allocation" }));
    await Bun.sleep(250);
  }
  return mkdtemp(join(tmpdir(), "observability-package-"));
};

allocationPromise = allocateTemporaryDirectory();
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

try {
  temporaryDirectory = await allocationPromise;
  if (terminationRequested) {
    await cleanup();
    await Bun.sleep(cleanupDeadlineMilliseconds);
  }
  if (cleanupTestIndex !== -1) {
    if (cleanupReadyFile === "") {
      throw new Error("The signal cleanup test requires a ready file path.");
    }
    if (cleanupScenario === "failure") {
      await writeFile(cleanupReadyFile, JSON.stringify({ phase: "failure", temporaryDirectory }));
      throw new Error("The package cleanup failure test failed as requested.");
    }
    if (cleanupScenario === "active" || cleanupScenario === "deadline") {
      const stubborn = cleanupScenario === "deadline";
      const descendantProgram = stubborn
        ? 'process.on("SIGTERM", () => undefined); await Bun.sleep(60000);'
        : "await Bun.sleep(60000);";
      const commandProgram = [
        stubborn ? 'process.on("SIGTERM", () => undefined);' : "",
        `const descendant = Bun.spawn(["bun", "--eval", ${JSON.stringify(descendantProgram)}], { stdout: "ignore", stderr: "ignore" });`,
        `await Bun.write(${JSON.stringify(cleanupReadyFile)}, JSON.stringify({ phase: "active", temporaryDirectory: ${JSON.stringify(temporaryDirectory)}, commandPid: process.pid, descendantPid: descendant.pid }));`,
        "await Bun.sleep(60000);",
      ].join("\n");
      await run(["bun", "--eval", commandProgram], root);
    } else if (cleanupScenario !== "allocation") {
      await writeFile(cleanupReadyFile, JSON.stringify({ phase: "idle", temporaryDirectory }));
      await Bun.sleep(60_000);
    }
  }

  const cliManifest: unknown = JSON.parse(
    await readFile(join(root, "packages/cli/package.json"), "utf8"),
  );
  const cliVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
    cliManifest,
  ).version;

  requireSuccess(await run(["bun", "run", "build"], root), "The package build");

  const packages = [
    {
      directory: join(root, "packages/telemetry"),
      archive: "telemetry.tgz",
      required: [
        "package/LICENSE",
        "package/README.md",
        "package/dist/LICENSE",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/Metrics.js",
        "package/dist/Metrics.d.ts",
        "package/dist/node/index.js",
        "package/dist/node/index.d.ts",
        "package/dist/nestjs/index.js",
        "package/dist/nestjs/index.d.ts",
        "package/dist/nestjs/RequestWideEventTraceCorrelation.js",
        "package/dist/nestjs/RequestWideEventTraceCorrelation.d.ts",
        "package/dist/browser/index.js",
        "package/dist/browser/index.d.ts",
        "package/dist/browser/client.js",
        "package/dist/browser/client.d.ts",
        "package/dist/testing/index.js",
        "package/dist/testing/index.d.ts",
      ],
    },
    {
      directory: join(root, "packages/cli"),
      archive: "cli.tgz",
      required: [
        "package/LICENSE",
        "package/README.md",
        "package/dist/LICENSE",
        "package/dist/main.js",
        "package/dist/main.d.ts",
        "package/dist/assets/docker-compose.yml",
        "package/dist/assets/local.yaml",
        "package/dist/assets/production.yaml",
        "package/dist/assets/kamal.accessory.yml",
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
    const packedLicense = await run(
      ["tar", "-xOf", join(temporaryDirectory, packageSpec.archive), "package/LICENSE"],
      temporaryDirectory,
    );
    requireSuccess(packedLicense, `Reading the root license from ${packageSpec.archive}`);
    const repositoryLicense = await readFile(join(root, "LICENSE"), "utf8");
    if (packedLicense.stdout !== repositoryLicense) {
      throw new Error(`The package root license differs in ${packageSpec.archive}.`);
    }
  }

  for (const nestMajor of [10, 11]) {
    const nestConsumer = join(temporaryDirectory, `nestjs-${nestMajor}-consumer`);
    await mkdir(nestConsumer, { recursive: true });
    await writeFile(
      join(nestConsumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "@equipe-tech/observability": `file:${join(temporaryDirectory, "telemetry.tgz")}`,
          "@nestjs/common": `^${nestMajor}.0.0`,
          "@nestjs/core": `^${nestMajor}.0.0`,
          "@nestjs/platform-express": `^${nestMajor}.0.0`,
          "@types/node": "^22.0.0",
          "reflect-metadata": "^0.2.2",
          rxjs: "^7.8.2",
        },
      }),
    );
    requireSuccess(
      await run(["bun", "install"], nestConsumer),
      `Installing the Nest ${nestMajor} packed consumer`,
    );
    for (const nestPackage of ["common", "core", "platform-express"]) {
      const manifest: unknown = JSON.parse(
        await readFile(
          join(nestConsumer, "node_modules/@nestjs", nestPackage, "package.json"),
          "utf8",
        ),
      );
      const version = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
        manifest,
      ).version;
      if (!version.startsWith(`${nestMajor}.`)) {
        throw new Error(
          `The Nest ${nestMajor} matrix installed @nestjs/${nestPackage} ${version}.`,
        );
      }
    }
    await writeFile(
      join(nestConsumer, "app.ts"),
      "import 'reflect-metadata';\nimport { Controller, Get, Module } from '@nestjs/common';\nimport { NestFactory } from '@nestjs/core';\nimport { createRequestWideEventTraceCorrelation, TelemetryModule } from '@equipe-tech/observability/nestjs';\nconst correlations: Array<{ readonly traceId: string; readonly spanId: string }> = [];\nconst traceCorrelation = createRequestWideEventTraceCorrelation(() => ({ set: (value) => correlations.push(value) }));\ntraceCorrelation.correlate({}, { traceId: '11111111111111111111111111111111', spanId: '1111111111111111' });\nif (correlations.length !== 1 || correlations[0]?.spanId !== '1111111111111111') throw new Error('Packed trace correlation bridge failed.');\nclass AppController { ping() { return { ok: true }; } }\nController()(AppController);\nconst descriptor = Object.getOwnPropertyDescriptor(AppController.prototype, 'ping');\nif (!descriptor) throw new Error('Missing ping descriptor.');\nGet('ping')(AppController.prototype, 'ping', descriptor);\nclass AppModule {}\nModule({ imports: [TelemetryModule.forRootAsync({ imports: undefined, inject: undefined, useFactory: async () => ({ enabled: false }) })], controllers: [AppController] })(AppModule);\nconst app = await NestFactory.create(AppModule, { logger: false });\nawait app.listen(0, '127.0.0.1');\nconst address = app.getHttpServer().address();\nif (!address || typeof address === 'string') throw new Error('Missing server address.');\nconst response = await fetch(`http://127.0.0.1:${address.port}/ping`);\nif (response.status !== 200 || (await response.json()).ok !== true) throw new Error('Packed Nest request failed.');\nawait app.close();\n",
    );
    await writeFile(
      join(nestConsumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["app.ts"],
      }),
    );
    requireSuccess(
      await run(
        ["bun", join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
        nestConsumer,
      ),
      `Type-checking the Nest ${nestMajor} packed consumer`,
    );
    const bridgeDeclaration = await readFile(
      join(
        nestConsumer,
        "node_modules/@equipe-tech/observability/dist/nestjs/RequestWideEventTraceCorrelation.d.ts",
      ),
      "utf8",
    );
    if (
      /from ["'](?:effect|evlog)(?:\/|["'])|import\(["'](?:effect|evlog)(?:\/|["'])/.test(
        bridgeDeclaration,
      )
    ) {
      throw new Error(
        "The request-wide event trace correlation declaration exposes Effect or evlog.",
      );
    }
    requireSuccess(
      await run(["bun", "app.ts"], nestConsumer),
      `Executing the Nest ${nestMajor} packed consumer`,
    );
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

  const nodeConsumer = join(temporaryDirectory, "node consumer outside repository");
  await mkdir(nodeConsumer, { recursive: true });
  await writeFile(
    join(nodeConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@equipe-tech/observability": `file:${join(temporaryDirectory, "telemetry.tgz")}`,
        "@equipe-tech/observability-cli": `file:${join(temporaryDirectory, "cli.tgz")}`,
      },
    }),
  );
  requireSuccess(
    await run(["npm", "install"], nodeConsumer),
    "Installing packed packages with npm",
  );
  requireSuccess(
    await run(
      [
        "node",
        "--input-type=module",
        "--eval",
        "const [root, metrics, node, browser, client, testing] = await Promise.all([import('@equipe-tech/observability'), import('@equipe-tech/observability/metrics'), import('@equipe-tech/observability/node'), import('@equipe-tech/observability/browser'), import('@equipe-tech/observability/browser/client'), import('@equipe-tech/observability/testing')]); if (!root.Telemetry || !root.ServiceName || !root.EnvironmentName || !root.CorrelationContext || root.Correlation || root.registerTestingAdapter || root.profileCapabilityRank || root.profileCapabilityRequirement || root.secondReleaseVariables || !root.registerOfficialAdapter || !root.ObservabilityLifecycleError || node.ObservabilityLifecycleError !== root.ObservabilityLifecycleError || !metrics.createMetrics || !node.runMain || !node.createNodeObservability || !node.makeNodeObservability || !node.layerNodeObservability || !browser.BrowserTelemetry || !client.createBrowserTelemetryClient || !testing.run || !testing.registerTestingAdapter) process.exit(1);",
      ],
      nodeConsumer,
    ),
    "Importing packed packages with Node.js",
  );
  requireSuccess(
    await run([join(nodeConsumer, "node_modules/.bin/observability"), "--help"], nodeConsumer),
    "Executing the npm-installed CLI",
  );

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
        "import * as Root from '@equipe-tech/observability'; import { Telemetry, WideEvent } from '@equipe-tech/observability'; import { createMetrics } from '@equipe-tech/observability/metrics'; import { createNodeObservability, ingestBrowserEvents, layerNodeObservability, makeNodeObservability, runMain } from '@equipe-tech/observability/node'; import { BrowserTelemetry } from '@equipe-tech/observability/browser'; import { createBrowserTelemetryClient } from '@equipe-tech/observability/browser/client'; import { registerTestingAdapter, run } from '@equipe-tech/observability/testing'; if (!Telemetry.layer || !WideEvent.emit || !createMetrics || !runMain || !createNodeObservability || !makeNodeObservability || !layerNodeObservability || !ingestBrowserEvents || !BrowserTelemetry.layer || !createBrowserTelemetryClient || !run || !registerTestingAdapter || 'registerTestingAdapter' in Root) process.exit(1);",
      ],
      consumer,
    ),
    "Importing the telemetry package",
  );
  await writeFile(
    join(consumer, "index.ts"),
    "import { Effect } from 'effect';\nimport { parseResourceIdentity, TelemetryConfig, type LifecycleCleanupResult as RootLifecycleCleanupResult } from '@equipe-tech/observability';\nimport { layer, type LifecycleCleanupResult as NodeLifecycleCleanupResult } from '@equipe-tech/observability/node';\nimport { BrowserTelemetry } from '@equipe-tech/observability/browser';\nimport { createBrowserTelemetryClient } from '@equipe-tech/observability/browser/client';\nimport { run } from '@equipe-tech/observability/testing';\nconst identity = await Effect.runPromise(parseResourceIdentity({ serviceName: 'test', serviceVersion: '1.0.0', environment: 'test' }));\nconst invalid = await Effect.runPromise(Effect.flip(parseResourceIdentity({ serviceName: 'Invalid', serviceVersion: '1.0.0', environment: 'test' })));\nif (invalid.code !== 'OBS_RESOURCE_IDENTITY_INVALID') throw new Error('Invalid packed identity did not return the public error code.');\nconst config = new TelemetryConfig({ identity, otlpEndpoint: new URL('http://localhost:4318') });\nconst rootCleanup: RootLifecycleCleanupResult = { kind: 'completed', durationMillis: 1 };\nconst nodeCleanup: NodeLifecycleCleanupResult = rootCleanup;\nvoid config;\nvoid rootCleanup;\nvoid nodeCleanup;\nvoid layer;\nvoid BrowserTelemetry;\nvoid createBrowserTelemetryClient;\nvoid run;\n",
  );
  await writeFile(
    join(consumer, "metrics-consumer.ts"),
    "import { createMetrics, type MetricAttribute, type MetricLabelRejection } from '@equipe-tech/observability/metrics';\nconst rejection: MetricLabelRejection = 'classification';\nvoid rejection;\nconst metrics = await createMetrics({ enabled: false, serviceName: 'packed-consumer', serviceVersion: '1.0.0', environment: 'test', otlpEndpoint: 'http://localhost:4318' });\nconst attributes: ReadonlyArray<MetricAttribute> = [{ key: 'packed.value', value: true }];\nconst counter = metrics.counter({ name: 'packed.counter', description: 'Packed counter', unit: '1' });\nconst histogram = metrics.histogram({ name: 'packed.histogram', description: 'Packed histogram', unit: 'ms', boundaries: [1, 10] });\nconst gauge = metrics.observableGauge({ name: 'packed.gauge', description: 'Packed gauge', unit: '%' }, () => [{ value: 4, attributes }]);\ncounter.add(1, attributes);\nhistogram.record(5, attributes);\ngauge.unregister();\nawait metrics.flush();\nawait metrics.close();\n",
  );
  const metricsDeclaration = await readFile(
    join(consumer, "node_modules/@equipe-tech/observability/dist/Metrics.d.ts"),
    "utf8",
  );
  if (/from ["']effect(?:\/|["'])|import\(["']effect(?:\/|["'])/.test(metricsDeclaration)) {
    throw new Error("The metrics facade declaration exposes an Effect module reference.");
  }
  requireSuccess(
    await run(["bun", "metrics-consumer.ts"], consumer),
    "Executing the packed metrics facade",
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
      include: ["index.ts", "metrics-consumer.ts"],
    }),
  );
  requireSuccess(
    await run(
      ["bun", join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      consumer,
    ),
    "Checking the telemetry declarations",
  );
  const browserClientDeclaration = await readFile(
    join(consumer, "node_modules/@equipe-tech/observability/dist/browser/BrowserClient.d.ts"),
    "utf8",
  );
  if (/\bEffect\b|from ["']effect["']/.test(browserClientDeclaration)) {
    throw new Error("The imperative browser client declaration exposes an Effect type.");
  }

  const browserSmokeSource = [
    "import { createBrowserTelemetryClient } from '@equipe-tech/observability/browser/client';",
    "const batches = [];",
    "const client = createBrowserTelemetryClient({ transport: async (batch) => { batches.push(batch); }, flushIntervalMs: 60000 });",
    "client.emit('packed.browser', { source: 'package-smoke' });",
    "if (client.pending() !== 1) throw new Error('The packed browser client did not queue synchronously.');",
    "await client.flush();",
    "await client.dispose();",
    "if (batches.length !== 1 || batches[0].events[0]?.name !== 'packed.browser') throw new Error('The packed browser client did not deliver through its public transport boundary.');",
  ].join("\n");
  const browserSmokeEntry = join(consumer, "browser-smoke.ts");
  const emptyEntry = join(consumer, "empty.ts");
  const browserBundle = join(consumer, "browser-smoke.min.js");
  const emptyBundle = join(consumer, "empty.min.js");
  await writeFile(browserSmokeEntry, browserSmokeSource);
  await writeFile(emptyEntry, "export {};\n");
  requireSuccess(
    await run(
      [
        "bun",
        "build",
        browserSmokeEntry,
        "--target=browser",
        "--minify",
        `--outfile=${browserBundle}`,
      ],
      consumer,
    ),
    "Bundling the packed browser facade",
  );
  requireSuccess(
    await run(
      ["bun", "build", emptyEntry, "--target=browser", "--minify", `--outfile=${emptyBundle}`],
      consumer,
    ),
    "Bundling the empty browser baseline",
  );
  requireSuccess(
    await run(["bun", browserBundle], consumer),
    "Executing the packed browser bundle",
  );
  const browserBytes = await Bun.file(browserBundle).bytes();
  const emptyBytes = await Bun.file(emptyBundle).bytes();
  const browserGzip = Bun.gzipSync(browserBytes, { level: 9 });
  const reproducedBrowserGzip = Bun.gzipSync(browserBytes, { level: 9 });
  const emptyGzip = Bun.gzipSync(emptyBytes, { level: 9 });
  if (
    browserGzip.byteLength !== reproducedBrowserGzip.byteLength ||
    !browserGzip.every((byte, index) => byte === reproducedBrowserGzip[index])
  ) {
    throw new Error("The isolated browser facade gzip output is not reproducible.");
  }
  const facadeGzipDeltaBytes = browserGzip.byteLength - emptyGzip.byteLength;
  const facadeGzipRegressionCeilingBytes = 80_000;
  const evidence = join(root, ".verification/observability/obs-11-browser-facade");
  await rm(evidence, { recursive: true, force: true });
  await mkdir(evidence, { recursive: true });
  await Bun.write(join(evidence, "browser-smoke.ts"), browserSmokeSource);
  await Bun.write(join(evidence, "browser-smoke.min.js"), browserBytes);
  await Bun.write(join(evidence, "browser-smoke.min.js.gz"), browserGzip);
  await Bun.write(join(evidence, "empty.min.js"), emptyBytes);
  await Bun.write(join(evidence, "empty.min.js.gz"), emptyGzip);
  await Bun.write(
    join(evidence, "evidence.json"),
    JSON.stringify(
      {
        command:
          "bun build browser-smoke.ts --target=browser --minify --outfile=browser-smoke.min.js",
        baselineCommand: "bun build empty.ts --target=browser --minify --outfile=empty.min.js",
        source: "packed @equipe-tech/observability ./browser/client public export only",
        browserMinifiedBytes: browserBytes.byteLength,
        browserMinifiedGzipBytes: browserGzip.byteLength,
        emptyMinifiedBytes: emptyBytes.byteLength,
        emptyMinifiedGzipBytes: emptyGzip.byteLength,
        facadeMinifiedGzipDeltaBytes: facadeGzipDeltaBytes,
        facadeGzipRegressionCeilingBytes,
        gzipReproductionMatched: true,
        hibouBudgetBytes: 550_000,
        hibouBaselineAssessed: false,
        budgetChanged: false,
        bunVersion: Bun.version,
      },
      undefined,
      2,
    ),
  );
  if (facadeGzipDeltaBytes > facadeGzipRegressionCeilingBytes) {
    throw new Error(
      `The isolated browser facade gzip delta is ${facadeGzipDeltaBytes} bytes, above the ${facadeGzipRegressionCeilingBytes} byte regression ceiling.`,
    );
  }

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
  const copiedCompose = await readFile(join(state, cliVersion, "docker-compose.yml"), "utf8");
  if (!copiedCompose.includes("observability-local")) {
    throw new Error("The packed CLI did not prepare the local stack assets.");
  }

  const provisionTarget = join(temporaryDirectory, "provision target");
  await mkdir(provisionTarget, { recursive: true });
  requireSuccess(
    await run([executable, "provision", "--dir", provisionTarget, "--name", "smoke-app"], consumer),
    "Provisioning the production assets with the packed CLI",
  );
  const provisionedCollector = await readFile(
    join(provisionTarget, "observability", "collector.yaml"),
    "utf8",
  );
  if (!provisionedCollector.includes("file_storage/queue")) {
    throw new Error("The packed CLI did not provision the production collector config.");
  }
  const provisionedAccessory = await readFile(
    join(provisionTarget, "observability", "kamal.accessory.yml"),
    "utf8",
  );
  if (!provisionedAccessory.includes("smoke-app-traces")) {
    throw new Error("The packed CLI did not render the Kamal accessory template.");
  }
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
