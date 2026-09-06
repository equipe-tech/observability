import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import {
  parseProjectName,
  projectNameFromDirectory,
  provisionAssets,
} from "../src/ProvisionAssets.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

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
        const first = yield* provisionAssets(source, target, "demo", false);
        const second = yield* provisionAssets(source, target, "demo", false);
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
    ]);
    expect(result.second).toEqual([
      { relativePath: "observability/collector.yaml", action: "unchanged" },
      { relativePath: "observability/kamal.accessory.yml", action: "unchanged" },
    ]);
    expect(result.collector).toBe("receivers: {}\n");
    expect(result.accessory).toBe("datasets: demo-traces demo-logs\n");
  });

  test("fails with a conflict and keeps local changes when a provisioned file was modified", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* provisionAssets(source, target, "demo", false);
        const collectorFile = path.join(target, "observability", "collector.yaml");
        yield* fs.writeFileString(collectorFile, "receivers: { otlp: {} }\n");
        const error = yield* Effect.flip(provisionAssets(source, target, "demo", false));
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
        yield* provisionAssets(source, target, "demo", false);
        const collectorFile = path.join(target, "observability", "collector.yaml");
        yield* fs.writeFileString(collectorFile, "receivers: { otlp: {} }\n");
        const files = yield* provisionAssets(source, target, "demo", true);
        const restored = yield* fs.readFileString(collectorFile);
        return { files, restored };
      }),
    );

    expect(result.files).toEqual([
      { relativePath: "observability/collector.yaml", action: "updated" },
      { relativePath: "observability/kamal.accessory.yml", action: "unchanged" },
    ]);
    expect(result.restored).toBe("receivers: {}\n");
  });

  test("returns a safe typed error when the packaged assets are missing", async () => {
    const result = await withTemporaryAssets((source, target) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const missing = path.join(source, "secret-missing-directory");
        const error = yield* Effect.flip(provisionAssets(missing, target, "demo", false));
        return { error, missing };
      }),
    );

    expect(result.error._tag).toBe("ProvisionError");
    expect(result.error.code).toBe("OBS_CLI_PROVISION_FAILED");
    expect(result.error.message).not.toContain(result.missing);
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
    expect(result.stdout).toContain("config/deploy.yml");

    const collector = await Bun.file(`${target}/observability/collector.yaml`).text();
    expect(collector).toContain("file_storage/queue");
    expect(collector).toContain("${env:AXIOM_TOKEN}");
    const accessory = await Bun.file(`${target}/observability/kamal.accessory.yml`).text();
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
});
