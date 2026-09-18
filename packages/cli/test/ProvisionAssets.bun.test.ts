import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  parseProjectName,
  parseQueueMode,
  projectNameFromDirectory,
  provisionAssets,
} from "../src/ProvisionAssets.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ProvisionStateDocument = {
  readonly version: number;
  readonly queueMode: string;
  readonly name: string;
  readonly assets: ReadonlyArray<{ readonly path: string; readonly digest: string }>;
};

const readProvisionState = (path: string): Promise<ProvisionStateDocument> => Bun.file(path).json();

const runCli = (args: Array<string>): Promise<CliResult> => {
  const child = Bun.spawn(["bun", main, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
};

const withTemporaryAssets = <A>(
  use: (
    source: string,
    target: string,
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "observability provision " });
      const source = path.join(root, "source assets");
      const target = path.join(root, "target project");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(source, "production.yaml"), "receivers: {}\n");
      yield* fs.writeFileString(
        path.join(source, "kamal.accessory.yml"),
        "datasets: {{name}}-traces {{name}}-logs\n",
      );
      return yield* use(source, target);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

describe("provisionAssets", () => {
  test("creates the rendered assets on the first run and reports them unchanged after", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const first = yield* provisionAssets(source, target, "demo", "durable", false);
        const second = yield* provisionAssets(source, target, "demo", "durable", false);
        const collector = yield* fs.readFileString(
          path.join(target, "observability", "collector.yaml"),
        );
        const accessory = yield* fs.readFileString(
          path.join(target, "observability", "kamal.accessory.yml"),
        );
        return { first, second, collector, accessory };
      }),
    );

    expect(result.first).toEqual([
      { relativePath: "observability/collector.yaml", action: "created" },
      { relativePath: "observability/kamal.accessory.yml", action: "created" },
      { relativePath: "observability/provision.json", action: "created" },
    ]);
    expect(result.second).toEqual([
      { relativePath: "observability/collector.yaml", action: "unchanged" },
      { relativePath: "observability/kamal.accessory.yml", action: "unchanged" },
      { relativePath: "observability/provision.json", action: "unchanged" },
    ]);
    expect(result.collector).toBe("receivers: {}\n");
    expect(result.accessory).toBe("datasets: demo-traces demo-logs\n");
  });

  test("fails with a conflict and keeps local changes when a provisioned file was modified", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* provisionAssets(source, target, "demo", "durable", false);
        const collectorFile = path.join(target, "observability", "collector.yaml");
        yield* fs.writeFileString(collectorFile, "receivers: { otlp: {} }\n");
        const error = yield* Effect.flip(provisionAssets(source, target, "demo", "durable", false));
        const preserved = yield* fs.readFileString(collectorFile);
        return { error, preserved };
      }),
    );

    expect(result.error._tag).toBe("ProvisionError");
    expect(result.error.code).toBe("OBS_CLI_PROVISION_CONFLICT");
    expect(result.error.message).toContain("observability/collector.yaml");
    expect(result.error.message).toContain("--force");
    expect(result.preserved).toBe("receivers: { otlp: {} }\n");
  });

  test("overwrites a modified file when force is set", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* provisionAssets(source, target, "demo", "durable", false);
        const collectorFile = path.join(target, "observability", "collector.yaml");
        yield* fs.writeFileString(collectorFile, "receivers: { otlp: {} }\n");
        const files = yield* provisionAssets(source, target, "demo", "durable", true);
        const restored = yield* fs.readFileString(collectorFile);
        return { files, restored };
      }),
    );

    expect(result.files).toEqual([
      { relativePath: "observability/collector.yaml", action: "updated" },
      { relativePath: "observability/kamal.accessory.yml", action: "unchanged" },
      { relativePath: "observability/provision.json", action: "unchanged" },
    ]);
    expect(result.restored).toBe("receivers: {}\n");
  });

  test("returns a safe typed error when the packaged assets are missing", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const missing = path.join(source, "secret-missing-directory");
        const error = yield* Effect.flip(
          provisionAssets(missing, target, "demo", "durable", false),
        );
        return { error, missing };
      }),
    );

    expect(result.error._tag).toBe("ProvisionError");
    expect(result.error.code).toBe("OBS_CLI_PROVISION_FAILED");
    expect(result.error.message).not.toContain(result.missing);
  });

  test("fails before writes when a best-effort delta marker changes", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const error = yield* Effect.flip(
          provisionAssets(source, target, "demo", "best-effort", false),
        );
        const outputExists = yield* fs.exists(path.join(target, "observability"));
        return { error, outputExists };
      }),
    );

    expect(result.error.code).toBe("OBS_CLI_PROVISION_ASSET_INCOMPATIBLE");
    expect(result.error.message).toContain("packaged observability assets");
    expect(result.error.message).not.toContain("filesystem permissions");
    expect(result.outputExists).toBe(false);
  });
});

describe("project names", () => {
  test("derives a DNS-safe name from the target directory", async () => {
    const name = await Effect.runPromise(projectNameFromDirectory("My Project_2.0"));
    expect(name).toBe("my-project-2-0");
  });

  test("rejects a directory that yields no valid name", async () => {
    const error = await Effect.runPromise(Effect.flip(projectNameFromDirectory("!!!")));
    expect(error.code).toBe("OBS_CLI_PROVISION_INVALID_NAME");
    expect(error.message).toContain("--name");
  });

  test("accepts a canonical explicit name", async () => {
    expect(await Effect.runPromise(parseProjectName("checkout-api"))).toBe("checkout-api");
  });

  test("rejects explicit names with consecutive hyphens", async () => {
    const error = await Effect.runPromise(Effect.flip(parseProjectName("checkout--api")));
    expect(error.code).toBe("OBS_CLI_PROVISION_INVALID_NAME");
  });

  test("rejects an explicit invalid name", async () => {
    const error = await Effect.runPromise(Effect.flip(parseProjectName("Bad Name")));
    expect(error.code).toBe("OBS_CLI_PROVISION_INVALID_NAME");
  });

  test("parses only supported queue modes", async () => {
    expect(await Effect.runPromise(parseQueueMode("best-effort"))).toBe("best-effort");
    expect(await Effect.runPromise(parseQueueMode("durable"))).toBe("durable");
    const error = await Effect.runPromise(Effect.flip(parseQueueMode("memory")));
    expect(error.code).toBe("OBS_CLI_PROVISION_INVALID_QUEUE_MODE");
  });
});

describe("observability provision", () => {
  test("provisions the packaged production assets into a project", async () => {
    const target = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-provision-cli-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );

    const result = await runCli(["provision", "--dir", target, "--name", "demo-app"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created  observability/collector.yaml");
    expect(result.stdout).toContain("created  observability/kamal.accessory.yml");
    expect(result.stdout).toContain("created  observability/provision.json");
    expect(result.stdout).toContain("config/deploy.yml");

    const collector = await Bun.file(`${target}/observability/collector.yaml`).text();
    const packagedCollector = await Bun.file(
      new URL("../src/assets/production.yaml", import.meta.url),
    ).text();
    expect(collector).toBe(packagedCollector);
    expect(collector).toContain("file_storage/queue");
    expect(collector).toContain("${env:AXIOM_TOKEN}");
    const accessory = await Bun.file(`${target}/observability/kamal.accessory.yml`).text();
    const packagedAccessory = await Bun.file(
      new URL("../src/assets/kamal.accessory.yml", import.meta.url),
    ).text();
    expect(accessory).toBe(packagedAccessory.replaceAll("{{name}}", "demo-app"));
    expect(accessory).toContain("demo-app-traces");
    expect(accessory).toContain("demo-app-logs");
    expect(accessory).toContain("demo-app-metrics");
    expect(accessory).not.toContain("{{name}}");

    const conflictFile = `${target}/observability/collector.yaml`;
    await Bun.write(conflictFile, "receivers: {}\n");
    const conflict = await runCli(["provision", "--dir", target, "--name", "demo-app"]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("OBS_CLI_PROVISION_CONFLICT");
    expect(conflict.stderr).not.toContain("OBS_CLI_UNEXPECTED");

    const forced = await runCli(["provision", "--dir", target, "--name", "demo-app", "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("updated  observability/collector.yaml");
  });

  test("rejects an invalid queue mode before creating the output directory", async () => {
    const root = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-invalid-queue-mode-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    const target = `${root}/not-created`;
    const result = await runCli([
      "provision",
      "--dir",
      target,
      "--name",
      "demo-app",
      "--queue-mode",
      "memory",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_PROVISION_INVALID_QUEUE_MODE");
    expect(await Bun.file(`${target}/observability/collector.yaml`).exists()).toBe(false);
    expect(await Bun.file(`${target}/observability/kamal.accessory.yml`).exists()).toBe(false);
    expect(await Bun.file(`${target}/observability/provision.json`).exists()).toBe(false);
  });

  test("keeps mode changes coherent and requires force", async () => {
    const target = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-mode-change-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    const durable = await runCli(["provision", "--dir", target, "--name", "demo-app"]);
    expect(durable.exitCode).toBe(0);
    const durableCollector = await Bun.file(`${target}/observability/collector.yaml`).text();
    const durableAccessory = await Bun.file(`${target}/observability/kamal.accessory.yml`).text();

    const conflict = await runCli([
      "provision",
      "--dir",
      target,
      "--name",
      "demo-app",
      "--queue-mode",
      "best-effort",
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("OBS_CLI_PROVISION_CONFLICT");
    expect(await Bun.file(`${target}/observability/collector.yaml`).text()).toBe(durableCollector);
    expect(await Bun.file(`${target}/observability/kamal.accessory.yml`).text()).toBe(
      durableAccessory,
    );

    const changed = await runCli([
      "provision",
      "--dir",
      target,
      "--name",
      "demo-app",
      "--queue-mode",
      "best-effort",
      "--force",
    ]);
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout).toContain("updated  observability/collector.yaml");
    expect(changed.stdout).toContain("updated  observability/kamal.accessory.yml");
    expect(changed.stdout).toContain("updated  observability/provision.json");

    const collector = await Bun.file(`${target}/observability/collector.yaml`).text();
    expect(collector).not.toContain("file_storage/queue");
    expect(collector.match(/queue_size: 64/g)).toHaveLength(3);
    expect(collector.match(/num_consumers: 1/g)).toHaveLength(3);
    expect(collector.match(/block_on_overflow: false/g)).toHaveLength(3);
    expect(collector.match(/initial_interval: 5s/g)).toHaveLength(3);
    expect(collector.match(/max_interval: 30s/g)).toHaveLength(3);
    expect(collector.match(/max_elapsed_time: 5m/g)).toHaveLength(3);
    const accessory = await Bun.file(`${target}/observability/kamal.accessory.yml`).text();
    expect(accessory).not.toContain("directories:");
    expect(accessory).not.toContain("/var/lib/otelcol/queue");
    const state = await Bun.file(`${target}/observability/provision.json`).json();
    expect(state.queueMode).toBe("best-effort");
    expect(state.name).toBe("demo-app");
    expect(state.assets).toHaveLength(2);

    const repeated = await runCli([
      "provision",
      "--dir",
      target,
      "--name",
      "demo-app",
      "--queue-mode",
      "best-effort",
    ]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout.match(/unchanged/g)).toHaveLength(3);
  });

  const forceRecoveryCases = [
    {
      label: "malformed",
      name: "demo-app",
      state: () => "{bad-json\n",
      accessoryAction: "unchanged",
    },
    {
      label: "future-version",
      name: "demo-app",
      state: (current: ProvisionStateDocument) => JSON.stringify({ ...current, version: 2 }),
      accessoryAction: "unchanged",
    },
    {
      label: "invalid",
      name: "demo-app",
      state: () => JSON.stringify({ version: 1 }),
      accessoryAction: "unchanged",
    },
    {
      label: "asset-identity",
      name: "demo-app",
      state: (current: ProvisionStateDocument) =>
        JSON.stringify({ ...current, assets: [...current.assets].reverse() }),
      accessoryAction: "unchanged",
    },
    {
      label: "project-name",
      name: "renamed-app",
      state: (current: ProvisionStateDocument) => JSON.stringify(current),
      accessoryAction: "updated",
    },
  ];

  for (const scenario of forceRecoveryCases) {
    test(`forces recovery from ${scenario.label} state without rewriting unchanged assets`, async () => {
      const target = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.makeTempDirectory({ prefix: `observability-force-${scenario.label}-` });
        }).pipe(Effect.provide(BunServices.layer)),
      );
      expect((await runCli(["provision", "--dir", target, "--name", "demo-app"])).exitCode).toBe(0);
      const collectorPath = `${target}/observability/collector.yaml`;
      const accessoryPath = `${target}/observability/kamal.accessory.yml`;
      const statePath = `${target}/observability/provision.json`;
      const currentState = await readProvisionState(statePath);
      await Bun.write(statePath, scenario.state(currentState));
      const before = {
        collector: await Bun.file(collectorPath).text(),
        accessory: await Bun.file(accessoryPath).text(),
        state: await Bun.file(statePath).text(),
        collectorInode: (await stat(collectorPath)).ino,
        accessoryInode: (await stat(accessoryPath)).ino,
      };

      const conflict = await runCli(["provision", "--dir", target, "--name", scenario.name]);
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr).toContain("OBS_CLI_PROVISION_CONFLICT");
      expect(await Bun.file(collectorPath).text()).toBe(before.collector);
      expect(await Bun.file(accessoryPath).text()).toBe(before.accessory);
      expect(await Bun.file(statePath).text()).toBe(before.state);

      const recovered = await runCli([
        "provision",
        "--dir",
        target,
        "--name",
        scenario.name,
        "--force",
      ]);
      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain("unchanged  observability/collector.yaml");
      expect(recovered.stdout).toContain(
        `${scenario.accessoryAction}  observability/kamal.accessory.yml`,
      );
      expect(recovered.stdout).toContain("updated  observability/provision.json");
      expect((await stat(collectorPath)).ino).toBe(before.collectorInode);
      if (scenario.accessoryAction === "unchanged")
        expect((await stat(accessoryPath)).ino).toBe(before.accessoryInode);
      else expect((await stat(accessoryPath)).ino).not.toBe(before.accessoryInode);
      const recoveredState = await readProvisionState(statePath);
      expect(recoveredState.version).toBe(1);
      expect(recoveredState.name).toBe(scenario.name);
      expect(recoveredState.assets.map((asset) => asset.path)).toEqual([
        "observability/collector.yaml",
        "observability/kamal.accessory.yml",
      ]);
    });
  }

  test("adopts a partial matching bundle and creates only missing files", async () => {
    const target = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-partial-bundle-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(
      (
        await runCli([
          "provision",
          "--dir",
          target,
          "--name",
          "demo-app",
          "--queue-mode",
          "best-effort",
        ])
      ).exitCode,
    ).toBe(0);
    const collectorPath = `${target}/observability/collector.yaml`;
    const collectorInode = (await stat(collectorPath)).ino;
    await rm(`${target}/observability/provision.json`);
    await rm(`${target}/observability/kamal.accessory.yml`);
    const adopted = await runCli([
      "provision",
      "--dir",
      target,
      "--name",
      "demo-app",
      "--queue-mode",
      "best-effort",
    ]);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toContain("unchanged  observability/collector.yaml");
    expect(adopted.stdout).toContain("created  observability/kamal.accessory.yml");
    expect(adopted.stdout).toContain("created  observability/provision.json");
    expect((await stat(collectorPath)).ino).toBe(collectorInode);
  });

  test("rejects a symlinked project target like the setup path boundary", async () => {
    const root = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "observability-symlink-target-" });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    const actual = `${root}/actual`;
    const linked = `${root}/linked`;
    await mkdir(actual);
    await symlink(actual, linked, "dir");
    const result = await runCli(["provision", "--dir", linked, "--name", "demo-app"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_PROVISION_CONFLICT");
    expect(await Bun.file(`${actual}/observability/provision.json`).exists()).toBe(false);
  });
});
