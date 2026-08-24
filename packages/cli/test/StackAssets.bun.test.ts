import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { prepareStackAssets } from "../src/StackAssets.ts";

describe("prepareStackAssets", () => {
  test("copies the stack into a writable state directory with spaces", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "observability package " });
        const source = path.join(root, "source assets");
        const state = path.join(root, "state directory");
        yield* fs.makeDirectory(source, { recursive: true });
        yield* fs.writeFileString(path.join(source, "docker-compose.yml"), "name: test\n");
        yield* fs.writeFileString(path.join(source, "local.yaml"), "receivers: {}\n");

        const composeFile = yield* prepareStackAssets(source, state);
        const compose = yield* fs.readFileString(composeFile);
        const collector = yield* fs.readFileString(path.join(state, "local.yaml"));
        const dataExists = yield* fs.exists(path.join(state, "data"));
        return {
          composeFile,
          expected: path.join(state, "docker-compose.yml"),
          compose,
          collector,
          dataExists,
        };
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    expect(result.composeFile).toBe(result.expected);
    expect(result.compose).toBe("name: test\n");
    expect(result.collector).toBe("receivers: {}\n");
    expect(result.dataExists).toBeTrue();
  });

  test("returns a safe typed error when packaged assets are missing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "observability-missing-" });
        const missing = path.join(root, "secret-source-path");
        const error = yield* Effect.flip(prepareStackAssets(missing, path.join(root, "state")));
        return { error, missing };
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    expect(result.error._tag).toBe("StackAssetsError");
    expect(result.error.code).toBe("OBS_CLI_ASSETS_FAILED");
    expect(result.error.message).not.toContain(result.missing);
  });
});
