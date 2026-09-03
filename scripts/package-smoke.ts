import { Schema } from "effect";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declarationReferenceViolations } from "./declaration-references.ts";
import { enforceBundleGzipBudget } from "./package-smoke-budget.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cleanupTestIndex = process.argv.indexOf("--signal-cleanup-test");
const cleanupReadyFile = cleanupTestIndex === -1 ? "" : (process.argv[cleanupTestIndex + 1] ?? "");
const cleanupScenario =
  cleanupTestIndex === -1 ? "" : (process.argv[cleanupTestIndex + 2] ?? "idle");
const requestedCleanupDeadline = Number(
  cleanupTestIndex === -1 ? "3000" : (process.argv[cleanupTestIndex + 3] ?? "3000"),
);
const cleanupSignalConfirmationFile =
  cleanupTestIndex === -1 ? "" : (process.argv[cleanupTestIndex + 4] ?? "");
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
let observedSignalCount = 0;
const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();
let allocationPromise = Promise.resolve("");

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const PackedManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodePackedManifest = Schema.decodeUnknownSync(PackedManifest);

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

type CleanupSignal = "SIGINT" | "SIGTERM";

const terminateAfterCleanup = (exitCode: number, signal: CleanupSignal): void => {
  observedSignalCount += 1;
  if (cleanupSignalConfirmationFile !== "") {
    writeFileSync(
      cleanupSignalConfirmationFile,
      JSON.stringify({ count: observedSignalCount, signal }),
      "utf8",
    );
  }
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

const onSigint = (): void => terminateAfterCleanup(130, "SIGINT");
const onSigterm = (): void => terminateAfterCleanup(143, "SIGTERM");

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
        "package/dist/effect/index.js",
        "package/dist/effect/index.d.ts",
        "package/dist/policy/entrypoint.js",
        "package/dist/policy/entrypoint.d.ts",
        "package/dist/browser/index.js",
        "package/dist/browser/index.d.ts",
        "package/dist/browser/client.js",
        "package/dist/browser/client.d.ts",
        "package/dist/testing/index.js",
        "package/dist/testing/index.d.ts",
      ],
    },
    {
      directory: join(root, "packages/evlog"),
      archive: "evlog.tgz",
      required: [
        "package/LICENSE",
        "package/README.md",
        "package/dist/LICENSE",
        "package/dist/index.js",
        "package/dist/index.d.ts",
      ],
    },
    {
      directory: join(root, "packages/sentry"),
      archive: "sentry.tgz",
      required: [
        "package/LICENSE",
        "package/README.md",
        "package/dist/LICENSE",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/node/index.js",
        "package/dist/node/index.d.ts",
        "package/dist/browser/index.js",
        "package/dist/browser/index.d.ts",
      ],
    },
    {
      directory: join(root, "packages/react"),
      archive: "react.tgz",
      required: [
        "package/LICENSE",
        "package/README.md",
        "package/dist/LICENSE",
        "package/dist/index.js",
        "package/dist/index.d.ts",
      ],
    },
    {
      directory: join(root, "packages/nestjs"),
      archive: "nestjs.tgz",
      required: [
        "package/LICENSE",
        "package/README.md",
        "package/dist/LICENSE",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/RequestWideEventTraceCorrelation.js",
        "package/dist/RequestWideEventTraceCorrelation.d.ts",
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
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/dist/query.js",
        "package/dist/query.d.ts",
        "package/package.json",
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
          "@equipe-tech/observability-nestjs": `file:${join(temporaryDirectory, "nestjs.tgz")}`,
          "@nestjs/common": `^${nestMajor}.0.0`,
          "@nestjs/core": `^${nestMajor}.0.0`,
          "@nestjs/platform-express": `^${nestMajor}.0.0`,
          "@types/node": "^22.0.0",
          effect: "4.0.0-rc.111",
          "reflect-metadata": "^0.2.2",
          rxjs: "^7.8.2",
        },
      }),
    );
    requireSuccess(
      await run(["bun", "install"], nestConsumer),
      `Installing the Nest ${nestMajor} packed consumer`,
    );
    if (await Bun.file(join(nestConsumer, "node_modules/evlog/package.json")).exists()) {
      throw new Error(`The Nest ${nestMajor} packed consumer installed the optional evlog peer.`);
    }
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
      "import 'reflect-metadata';\nimport { Controller, Get, Module } from '@nestjs/common';\nimport { NestFactory } from '@nestjs/core';\nimport { Schema } from 'effect';\nimport { createRequestWideEventTraceCorrelation, TelemetryModule } from '@equipe-tech/observability-nestjs';\nconst correlations: Array<{ readonly traceId: string; readonly spanId: string }> = [];\nconst traceCorrelation = createRequestWideEventTraceCorrelation(() => ({ set: (value) => correlations.push(value) }));\ntraceCorrelation.correlate({}, { traceId: '11111111111111111111111111111111', spanId: '1111111111111111' });\nif (correlations.length !== 1 || correlations[0]?.spanId !== '1111111111111111') throw new Error('Packed trace correlation bridge failed.');\nclass AppController { ping() { return { ok: true }; } }\nController()(AppController);\nconst descriptor = Object.getOwnPropertyDescriptor(AppController.prototype, 'ping');\nif (!descriptor) throw new Error('Missing ping descriptor.');\nGet('ping')(AppController.prototype, 'ping', descriptor);\nclass AppModule {}\nModule({ imports: [TelemetryModule.forRootAsync({ imports: undefined, inject: undefined, useFactory: async () => ({ enabled: false }) })], controllers: [AppController] })(AppModule);\nconst app = await NestFactory.create(AppModule, { logger: false });\nawait app.listen(0, '127.0.0.1');\nconst address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(app.getHttpServer().address());\nconst response = await fetch(`http://127.0.0.1:${address.port}/ping`);\nif (response.status !== 200 || (await response.json()).ok !== true) throw new Error('Packed Nest request failed.');\nawait app.close();\n",
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
        "node_modules/@equipe-tech/observability-nestjs/dist/RequestWideEventTraceCorrelation.d.ts",
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
        "@equipe-tech/observability-evlog": `file:${join(temporaryDirectory, "evlog.tgz")}`,
        "@equipe-tech/observability-nestjs": `file:${join(temporaryDirectory, "nestjs.tgz")}`,
        "@equipe-tech/observability-sentry": `file:${join(temporaryDirectory, "sentry.tgz")}`,
        "@equipe-tech/observability-react": `file:${join(temporaryDirectory, "react.tgz")}`,
        "@sentry/browser": "10.72.0",
        "@sentry/node-core": "10.72.0",
        effect: "4.0.0-rc.111",
      },
      overrides: {
        "@equipe-tech/observability-sentry": `file:${join(temporaryDirectory, "sentry.tgz")}`,
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
        "@equipe-tech/observability-evlog": `file:${join(temporaryDirectory, "evlog.tgz")}`,
        "@equipe-tech/observability-nestjs": `file:${join(temporaryDirectory, "nestjs.tgz")}`,
        "@equipe-tech/observability-sentry": `file:${join(temporaryDirectory, "sentry.tgz")}`,
        "@sentry/node-core": "10.72.0",
        "@nestjs/common": "^11.0.0",
        "@nestjs/core": "^11.0.0",
        effect: "4.0.0-rc.111",
        "reflect-metadata": "^0.2.2",
        rxjs: "^7.2.0",
      },
    }),
  );
  requireSuccess(
    await run(["npm", "install"], nodeConsumer),
    "Installing packed packages with npm",
  );

  const coreOnlyConsumer = join(temporaryDirectory, "core only consumer");
  await mkdir(coreOnlyConsumer, { recursive: true });
  await writeFile(
    join(coreOnlyConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@equipe-tech/observability": `file:${join(temporaryDirectory, "telemetry.tgz")}`,
        effect: "4.0.0-rc.111",
      },
    }),
  );
  requireSuccess(
    await run(["bun", "install"], coreOnlyConsumer),
    "Installing the core package without the evlog adapter",
  );
  requireSuccess(
    await run(
      [
        "bun",
        "--eval",
        "const root = await import('@equipe-tech/observability'); const node = await import('@equipe-tech/observability/node'); if (!root.Telemetry || !root.parseAuditRecord || !root.commitAuditRecord || !root.drainAuditOutbox || !root.AuditPublisher || !node.layerNodeAuditDigest || !node.createNodeObservability) process.exit(1);",
      ],
      coreOnlyConsumer,
    ),
    "Importing core without the evlog adapter",
  );

  requireSuccess(
    await run(
      [
        "node",
        "--input-type=module",
        "--eval",
        "const [root, effectEntry, metrics, node, evlog, nestjs, browser, client, testing, policy, sentry, sentryNode] = await Promise.all([import('@equipe-tech/observability'), import('@equipe-tech/observability/effect'), import('@equipe-tech/observability/metrics'), import('@equipe-tech/observability/node'), import('@equipe-tech/observability-evlog'), import('@equipe-tech/observability-nestjs'), import('@equipe-tech/observability/browser'), import('@equipe-tech/observability/browser/client'), import('@equipe-tech/observability/testing'), import('@equipe-tech/observability/policy'), import('@equipe-tech/observability-sentry'), import('@equipe-tech/observability-sentry/node')]); if ('WideEvent' in root || 'layerWideEvent' in root || !effectEntry.WideEvent || !effectEntry.layerWideEvent || !root.Telemetry || !root.parseAuditRecord || !root.commitAuditRecord || !root.drainAuditOutbox || !root.AuditPublisher || Object.keys(root).some((name) => name.toLowerCase().includes('audit') && (name in browser || name in client)) || !root.ServiceName || !root.EnvironmentName || !root.CorrelationContext || root.Correlation || root.registerTestingAdapter || root.profileCapabilityRank || root.profileCapabilityRequirement || root.secondReleaseVariables || root.baseBlockedValuePatterns || !root.registerOfficialAdapter || !root.ObservabilityLifecycleError || node.ObservabilityLifecycleError !== root.ObservabilityLifecycleError || nestjs.ObservabilityLifecycleError !== root.ObservabilityLifecycleError || nestjs.CurrentCorrelation !== root.CurrentCorrelation || nestjs.TelemetryEventSink !== root.TelemetryEventSink || !evlog.evlogAdapter || !nestjs.TelemetryModule || !metrics.createMetrics || !node.runMain || !node.layerNodeAuditDigest || !node.createNodeObservability || !node.makeNodeObservability || !node.layerNodeObservability || !browser.BrowserTelemetry || !client.createBrowserTelemetryClient || !testing.run || !testing.registerTestingAdapter || !policy.sanitizeDefectEnvelope || !sentry.sentrySourceMapUpload || !sentryNode.sentryDefectAdapter) process.exit(1); try { await import('@sentry/browser'); process.exit(1); } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') process.exit(1); } try { await import('@equipe-tech/observability/nestjs'); process.exit(1); } catch (error) { if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(1); }",
      ],
      nodeConsumer,
    ),
    "Importing packed packages with Node.js",
  );
  requireSuccess(
    await run([join(nodeConsumer, "node_modules/.bin/observability"), "--help"], nodeConsumer),
    "Executing the npm-installed CLI",
  );
  requireSuccess(
    await run(
      [
        "node",
        "--input-type=module",
        "--eval",
        "const [root, query, manifest, effect] = await Promise.all([import('@equipe-tech/observability-cli'), import('@equipe-tech/observability-cli/query'), import('@equipe-tech/observability-cli/package.json', { with: { type: 'json' } }), import('effect')]); const parsed = await effect.Effect.runPromise(root.parseManagedQuery('signal(logs) | where event.name == \"payment.attempt\" | summarize count()')); const compiled = await effect.Effect.runPromise(query.compileManagedQuery(parsed, { dataset: 'checkout-production-logs', language: 'apl', signals: ['payment.attempt'] })); if (root.compileManagedQuery !== query.compileManagedQuery || manifest.default.name !== '@equipe-tech/observability-cli' || !compiled.text.includes(`['checkout-production-logs']`) || !compiled.text.includes(`['event.name'] == 'payment.attempt'`)) process.exit(1);",
      ],
      nodeConsumer,
    ),
    "Executing the packed CLI root, query and package manifest entrypoints",
  );

  const browserConsumer = join(temporaryDirectory, "browser consumer outside repository");
  await mkdir(browserConsumer, { recursive: true });
  await writeFile(
    join(browserConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@equipe-tech/observability": `file:${join(temporaryDirectory, "telemetry.tgz")}`,
        "@equipe-tech/observability-sentry": `file:${join(temporaryDirectory, "sentry.tgz")}`,
        "@equipe-tech/observability-react": `file:${join(temporaryDirectory, "react.tgz")}`,
        "@sentry/browser": "10.72.0",
        effect: "4.0.0-rc.111",
      },
      overrides: {
        "@equipe-tech/observability-sentry": `file:${join(temporaryDirectory, "sentry.tgz")}`,
      },
    }),
  );
  requireSuccess(
    await run(["npm", "install"], browserConsumer),
    "Installing the packed browser Sentry consumer",
  );
  requireSuccess(
    await run(
      [
        "node",
        "--input-type=module",
        "--eval",
        "const registry = Symbol.for('@equipe-tech/observability-react/active-hosts'); Object.defineProperty(globalThis, registry, { configurable: true, value: {}, writable: true }); const poisoned = Object.getOwnPropertyDescriptor(globalThis, registry); const [browser, coreBrowser, policy, profile, root] = await Promise.all([import('@equipe-tech/observability-sentry/browser'), import('@equipe-tech/observability/browser'), import('@equipe-tech/observability/policy'), import('@equipe-tech/observability/react-web-profile'), import('@equipe-tech/observability')]); const react = await import('@equipe-tech/observability-react'); const auditApiNames = Object.keys(root).filter((name) => name.toLowerCase().includes('audit')); if (auditApiNames.some((name) => name in coreBrowser || name in react)) process.exit(1); const imported = Object.getOwnPropertyDescriptor(globalThis, registry); if (imported?.value !== poisoned?.value || imported?.writable !== true || imported?.configurable !== true) process.exit(1); if (!browser.createBrowserSentryDefectReporter || !react.createBrowserObservability || !Object.isFrozen(profile.reactWebLifecycle)) process.exit(1); const lifecycle = profile.reactWebLifecycle; for (const name of ['environmentRequiringDefects', 'shutdownDeadlineMillis', 'eventShutdownDeadlineMillis', 'sentryDeadlineMillis', 'flushDeadlineMillis']) { const descriptor = Object.getOwnPropertyDescriptor(lifecycle, name); if (descriptor?.writable !== false || descriptor.configurable !== false) process.exit(1); } try { Object.defineProperty(lifecycle, 'environmentRequiringDefects', { value: 'bypassed' }); process.exit(1); } catch (error) { if (!(error instanceof TypeError)) process.exit(1); } try { Object.defineProperty(lifecycle, 'eventShutdownDeadlineMillis', { value: 1 }); process.exit(1); } catch (error) { if (!(error instanceof TypeError)) process.exit(1); } if (lifecycle.environmentRequiringDefects !== 'production' || lifecycle.eventShutdownDeadlineMillis !== 1150) process.exit(1); const config = { service: { name: 'packed-web', version: '0.3.0', environment: 'test' }, policy: policy.definePolicy({ attributes: { 'error.origin': { classification: 'internal', required: true, metricLabel: false } }, blockedKeys: [], blockedValuePatterns: [] }), sentry: { disabled: true } }; const inert = react.createBrowserObservability(config); if (inert.installed) process.exit(1); await inert.dispose(); const listeners = new Map(); const host = { addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); } }; try { react.createBrowserObservability({ ...config, service: { ...config.service, environment: 'production' }, host }); process.exit(1); } catch (error) { if (error?.code !== 'OBS_REACT_CONFIG_INVALID') process.exit(1); } const active = react.createBrowserObservability({ ...config, host }); const recovered = Object.getOwnPropertyDescriptor(globalThis, registry); if (recovered?.writable !== false || recovered?.configurable !== false || !(recovered?.value instanceof WeakSet)) process.exit(1); if (!active.installed || active.defects.report({ error: new Error('packed'), origin: 'manual' }).kind !== 'recorded') process.exit(1); const duplicateReact = await import(`${import.meta.resolve('@equipe-tech/observability-react')}?duplicate-bundle`); try { duplicateReact.createBrowserObservability({ ...config, host }); process.exit(1); } catch (error) { if (error?.code !== 'OBS_REACT_ALREADY_INSTALLED') process.exit(1); } await active.dispose(); const replacement = duplicateReact.createBrowserObservability({ ...config, host }); await replacement.dispose(); if (listeners.size !== 0) process.exit(1); try { await import('@sentry/node-core'); process.exit(1); } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') process.exit(1); }",
      ],
      browserConsumer,
    ),
    "Importing the packed browser Sentry consumer without node-core",
  );

  const declarations = new Bun.Glob("**/*.d.ts");
  for (const packageName of [
    "observability",
    "observability-evlog",
    "observability-nestjs",
    "observability-sentry",
    "observability-react",
    "observability-cli",
  ]) {
    const packageDirectory = join(consumer, "node_modules/@equipe-tech", packageName);
    const distribution = join(packageDirectory, "dist");
    const manifestValue: unknown = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    const manifest = decodePackedManifest(manifestValue);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for await (const declaration of declarations.scan({ cwd: distribution })) {
      const source = await Bun.file(join(distribution, declaration)).text();
      if (/(["']\.[^"']+)\.ts(["'])/.test(source)) {
        throw new Error(`The declaration ${declaration} contains a TypeScript source specifier.`);
      }
      if (source.includes("packages/") || source.includes("/src/") || source.includes(root)) {
        throw new Error(`The declaration ${declaration} exposes a source or absolute path.`);
      }
      if (
        packageName === "observability" &&
        /@nestjs\/|(?:from|import\()["'](?:rxjs|evlog|reflect-metadata|react|react-dom|@sentry\/)/.test(
          source,
        )
      ) {
        throw new Error(`The core declaration ${declaration} exposes a framework dependency.`);
      }
      if (
        packageName === "observability-evlog" &&
        /\b(?:DrainContext|DrainFn|OTLPConfig|OTLPLogRecord|WideEvent)\b/.test(source)
      ) {
        throw new Error(`The evlog adapter declaration ${declaration} exposes evlog internals.`);
      }
      if (packageName === "observability-sentry" && /@sentry\//.test(source)) {
        throw new Error(`The Sentry adapter declaration ${declaration} exposes SDK internals.`);
      }
      for (const violation of declarationReferenceViolations(source, declared)) {
        if (violation.kind === "source-path") {
          throw new Error(
            `The declaration ${declaration} exposes source path reference ${violation.specifier}.`,
          );
        }
        throw new Error(
          `The declaration ${declaration} imports undeclared dependency ${violation.specifier}.`,
        );
      }
    }
  }
  const coreRuntimeFiles = new Bun.Glob("**/*.js");
  for await (const runtimeFile of coreRuntimeFiles.scan({
    cwd: join(consumer, "node_modules/@equipe-tech/observability/dist"),
  })) {
    const source = await Bun.file(
      join(consumer, "node_modules/@equipe-tech/observability/dist", runtimeFile),
    ).text();
    if (/(?:from|import\()["']evlog(?:\/|["'])/.test(source)) {
      throw new Error(`The core runtime ${runtimeFile} imports evlog.`);
    }
  }

  requireSuccess(
    await run(
      [
        "bun",
        "-e",
        "import * as Root from '@equipe-tech/observability'; import { Telemetry } from '@equipe-tech/observability'; import { evlogAdapter } from '@equipe-tech/observability-evlog'; import { WideEvent, layerWideEvent } from '@equipe-tech/observability/effect'; import { createMetrics } from '@equipe-tech/observability/metrics'; import { createNodeObservability, ingestBrowserEvents, layerNodeObservability, makeNodeObservability, runMain } from '@equipe-tech/observability/node'; import { BrowserTelemetry } from '@equipe-tech/observability/browser'; import { createBrowserTelemetryClient } from '@equipe-tech/observability/browser/client'; import { registerTestingAdapter, run } from '@equipe-tech/observability/testing'; const failed = [!Telemetry.layer, !evlogAdapter, !WideEvent.emit, !layerWideEvent, 'WideEvent' in Root, 'layerWideEvent' in Root, !createMetrics, !runMain, !createNodeObservability, !makeNodeObservability, !layerNodeObservability, !ingestBrowserEvents, !BrowserTelemetry.layer, !createBrowserTelemetryClient, !run, !registerTestingAdapter, 'registerTestingAdapter' in Root, 'baseBlockedValuePatterns' in Root].findIndex(Boolean); if (failed !== -1) throw new Error(`Packed export check ${failed} failed.`); let rejected = false; try { await import('@equipe-tech/observability/nestjs'); } catch { rejected = true; } if (!rejected) throw new Error('The removed NestJS path resolved in Bun.');",
      ],
      consumer,
    ),
    "Importing the telemetry package",
  );
  await writeFile(
    join(consumer, "old-nestjs.ts"),
    "import { TelemetryModule } from '@equipe-tech/observability/nestjs';\nvoid TelemetryModule;\n",
  );
  const oldNestResolution = await run(
    [
      "bun",
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "Preserve",
      "--moduleResolution",
      "Bundler",
      "--target",
      "ESNext",
      "old-nestjs.ts",
    ],
    consumer,
  );
  if (oldNestResolution.exitCode === 0) {
    throw new Error("TypeScript resolved the removed core NestJS entrypoint.");
  }
  const oldNestDiagnostic = `${oldNestResolution.stdout}${oldNestResolution.stderr}`;
  if (
    !oldNestDiagnostic.includes("TS2307") ||
    !oldNestDiagnostic.includes("@equipe-tech/observability/nestjs")
  ) {
    throw new Error("The earlier consumer did not fail for the declared NestJS entrypoint break.");
  }
  for (const candidate of [
    {
      file: "browser-audit-invalid.ts",
      entrypoint: "@equipe-tech/observability/browser",
    },
    {
      file: "react-audit-invalid.ts",
      entrypoint: "@equipe-tech/observability-react",
    },
  ]) {
    await writeFile(
      join(consumer, candidate.file),
      `import type { CommittedAuditRecord } from '${candidate.entrypoint}';\ndeclare const record: CommittedAuditRecord;\nvoid record;\n`,
    );
    const auditResolution = await run(
      [
        "bun",
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--module",
        "Preserve",
        "--moduleResolution",
        "Bundler",
        "--target",
        "ESNext",
        candidate.file,
      ],
      consumer,
    );
    if (auditResolution.exitCode === 0) {
      throw new Error(`TypeScript resolved the audit API from ${candidate.entrypoint}.`);
    }
  }
  await writeFile(
    join(consumer, "index.ts"),
    "import { Effect } from 'effect';\nimport { parseResourceIdentity, TelemetryConfig, type LifecycleCleanupResult as RootLifecycleCleanupResult } from '@equipe-tech/observability';\nimport { layer, type LifecycleCleanupResult as NodeLifecycleCleanupResult } from '@equipe-tech/observability/node';\nimport { BrowserTelemetry } from '@equipe-tech/observability/browser';\nimport { createBrowserTelemetryClient } from '@equipe-tech/observability/browser/client';\nimport { run } from '@equipe-tech/observability/testing';\nconst identity = await Effect.runPromise(parseResourceIdentity({ serviceName: 'test', serviceVersion: '1.0.0', environment: 'test' }));\nconst invalid = await Effect.runPromise(Effect.flip(parseResourceIdentity({ serviceName: 'Invalid', serviceVersion: '1.0.0', environment: 'test' })));\nif (invalid.code !== 'OBS_RESOURCE_IDENTITY_INVALID') throw new Error('Invalid packed identity did not return the public error code.');\nconst config = new TelemetryConfig({ identity, otlpEndpoint: new URL('http://localhost:4318') });\nconst rootCleanup: RootLifecycleCleanupResult = { kind: 'completed', durationMillis: 1 };\nconst nodeCleanup: NodeLifecycleCleanupResult = rootCleanup;\nvoid config;\nvoid rootCleanup;\nvoid nodeCleanup;\nvoid layer;\nvoid BrowserTelemetry;\nvoid createBrowserTelemetryClient;\nvoid run;\n",
  );
  await writeFile(
    join(consumer, "metrics-consumer.ts"),
    "import { Effect } from 'effect';\nimport { defineTelemetryContract, makeMetricProducer } from '@equipe-tech/observability';\nimport { createMetrics, type MetricLabelRejection } from '@equipe-tech/observability/metrics';\nimport { invalidMetricDefinitionFixtures, metricDefinitionFixtures } from '@equipe-tech/observability/testing';\nconst rejection: MetricLabelRejection = 'classification';\nvoid rejection;\nvoid invalidMetricDefinitionFixtures;\nconst contract = await Effect.runPromise(defineTelemetryContract({ version: 1, events: {}, metrics: metricDefinitionFixtures, auditActions: {} }));\nconst metrics = await createMetrics({ enabled: false, serviceName: 'packed-consumer', serviceVersion: '1.0.0', environment: 'test', otlpEndpoint: 'http://localhost:4318' });\nconst producer = makeMetricProducer(contract, metrics);\nproducer.counter('Counter').add(1, {});\nproducer.histogram('Histogram').record(5, {});\nconst gauge = producer.observableGauge('ObservableGauge', () => [{ value: 4, attributes: {} }]);\ngauge.unregister();\nawait metrics.flush();\nawait metrics.close();\n",
  );
  const producerTypePrefix =
    "import { Contract, makeMetricProducer } from '@equipe-tech/observability';\nimport type { Metrics } from '@equipe-tech/observability/metrics';\nconst definition = Contract.telemetryContractDefinition({ version: 1, events: {}, metrics: { Counter: { name: 'packed.counter', description: 'Counter', unit: '1', kind: 'counter', attributes: { 'packed.channel': { classification: 'public', allowedValues: ['web', 'mobile'], maximumCardinality: 2 } } }, Histogram: { name: 'packed.histogram', description: 'Histogram', unit: 'ms', kind: 'histogram', boundaries: [1, 10], attributes: {} } }, auditActions: {} });\ndeclare const contract: Contract.TelemetryContract<typeof definition>;\ndeclare const metrics: Metrics;\nconst producer = makeMetricProducer(contract, metrics);\n";
  await writeFile(
    join(consumer, "producer-types.ts"),
    `${producerTypePrefix}producer.counter('Counter').add(1, { 'packed.channel': 'web' });\nproducer.histogram('Histogram').record(5, {});\n`,
  );
  const producerTypeArguments = [
    "bun",
    join(root, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--module",
    "Preserve",
    "--moduleResolution",
    "Bundler",
    "--target",
    "ESNext",
    "--strict",
  ];
  requireSuccess(
    await run([...producerTypeArguments, "producer-types.ts"], consumer),
    "Checking the positive contract producer type control",
  );
  for (const invalidProducerUse of [
    "producer.counter('Histogram');",
    "producer.counter('Counter').add(1, { 'packed.channel': 'partner' });",
    "producer.counter('Counter').add(1, { 'packed.channel': 'web', 'packed.extra': true });",
    "Contract.telemetryContractDefinition({ version: 1, events: {}, metrics: { Bad: { name: 'packed.bad', description: 'Bad', unit: '1', kind: 'counter', boundaries: [1], attributes: {} } }, auditActions: {} });",
    "Contract.telemetryContractDefinition({ version: 1, events: {}, metrics: { Bad: { name: 'packed.bad', description: 'Bad', unit: '1', kind: 'histogram', attributes: {} } }, auditActions: {} });",
  ]) {
    await writeFile(
      join(consumer, "producer-invalid.ts"),
      `${producerTypePrefix}${invalidProducerUse}\n`,
    );
    const invalidProducerResult = await run(
      [...producerTypeArguments, "producer-invalid.ts"],
      consumer,
    );
    if (invalidProducerResult.exitCode === 0) {
      throw new Error(`TypeScript accepted invalid contract producer use: ${invalidProducerUse}`);
    }
  }
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
      include: ["index.ts", "metrics-consumer.ts", "producer-types.ts"],
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
  const browserClientRuntimeFiles = await Promise.all(
    ["client.js", "BrowserClient.js", "ClientPolicy.js", "BrowserEventLimits.js"].map((file) =>
      readFile(
        join(consumer, "node_modules/@equipe-tech/observability/dist/browser", file),
        "utf8",
      ),
    ),
  );
  if (browserClientRuntimeFiles.some((source) => /from\s*["']effect["']/.test(source))) {
    throw new Error("The imperative browser client production graph imports Effect or Schema.");
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
  enforceBundleGzipBudget({
    artifact: "The isolated browser facade",
    deltaBytes: facadeGzipDeltaBytes,
    ceilingBytes: facadeGzipRegressionCeilingBytes,
  });

  const reactSmokeSource = [
    "import { createBrowserObservability } from '@equipe-tech/observability-react';",
    "import { definePolicy } from '@equipe-tech/observability/policy';",
    "const policy = definePolicy({ attributes: { 'error.origin': { classification: 'internal', required: true, metricLabel: false } }, blockedKeys: [], blockedValuePatterns: [] });",
    "const handle = createBrowserObservability({ service: { name: 'bundle-smoke', version: '0.3.0', environment: 'test' }, policy, sentry: { disabled: true } });",
    "await handle.dispose();",
  ].join("\n");
  const reactSmokeEntry = join(consumer, "react-smoke.ts");
  const reactBundle = join(consumer, "react-smoke.min.js");
  await writeFile(reactSmokeEntry, reactSmokeSource);
  requireSuccess(
    await run(
      ["bun", "build", reactSmokeEntry, "--target=browser", "--minify", `--outfile=${reactBundle}`],
      consumer,
    ),
    "Bundling the packed React production entrypoint",
  );
  requireSuccess(await run(["bun", reactBundle], consumer), "Executing the packed React bundle");
  const reactBytes = await Bun.file(reactBundle).bytes();
  const reactGzip = Bun.gzipSync(reactBytes, { level: 9 });
  const reactGzipDeltaBytes = reactGzip.byteLength - emptyGzip.byteLength;
  const reactGzipRegressionCeilingBytes = 137_372;
  const reactEvidence = join(root, ".verification/observability/obs-54-react-bundle");
  await rm(reactEvidence, { recursive: true, force: true });
  await mkdir(reactEvidence, { recursive: true });
  await Bun.write(join(reactEvidence, "react-smoke.ts"), reactSmokeSource);
  await Bun.write(join(reactEvidence, "react-smoke.min.js"), reactBytes);
  await Bun.write(join(reactEvidence, "react-smoke.min.js.gz"), reactGzip);
  await Bun.write(
    join(reactEvidence, "evidence.json"),
    JSON.stringify(
      {
        command: "bun build react-smoke.ts --target=browser --minify --outfile=react-smoke.min.js",
        baselineCommand: "bun build empty.ts --target=browser --minify --outfile=empty.min.js",
        source: "packed @equipe-tech/observability-react production entrypoint",
        reactMinifiedBytes: reactBytes.byteLength,
        reactMinifiedGzipBytes: reactGzip.byteLength,
        emptyMinifiedGzipBytes: emptyGzip.byteLength,
        reactMinifiedGzipDeltaBytes: reactGzipDeltaBytes,
        reactGzipRegressionCeilingBytes,
        bunVersion: Bun.version,
      },
      undefined,
      2,
    ),
  );
  enforceBundleGzipBudget({
    artifact: "The React production entrypoint",
    deltaBytes: reactGzipDeltaBytes,
    ceilingBytes: reactGzipRegressionCeilingBytes,
  });

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
