import { expect, it } from "bun:test";
import { Effect } from "effect";
import { ApplicationCanary } from "../src/ApplicationCanary.ts";
import { authenticationTokenFromEnvironment } from "../src/AuthenticationInput.ts";

it("imports the CLI root with an empty ambient canary command", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'await import("./packages/cli/src/index.ts"); console.log("import succeeded")',
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, OBSERVABILITY_APPLICATION_CANARY_COMMAND: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain("import succeeded");
});

it("decodes canary input at execution and returns safe typed prerequisite failures", async () => {
  const original = process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND;
  const run = Effect.flatMap(ApplicationCanary, (canary) => canary.run).pipe(
    Effect.provide(ApplicationCanary.layer),
  );
  try {
    for (const command of [undefined, "", "  ", "\u0000"]) {
      if (command === undefined) delete process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND;
      else process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND = command;
      const result = await Effect.runPromise(run.pipe(Effect.flip));
      expect(result).toMatchObject({
        _tag: "SetupError",
        code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
        retryable: true,
      });
      expect(result.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(result).not.toHaveProperty("traceId");
      expect(result.cause).toBe("missing or invalid application canary command");
    }
    process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND = "exit 0";
    await Effect.runPromise(run);
    process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND = "exit 23";
    expect(await Effect.runPromise(run.pipe(Effect.flip))).toMatchObject({
      code: "OBS_SETUP_RELEASE_PREREQUISITE_MISSING",
      retryable: false,
      cause: 23,
    });
  } finally {
    if (original === undefined) delete process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND;
    else process.env.OBSERVABILITY_APPLICATION_CANARY_COMMAND = original;
  }
});

it("identifies authentication input failures as local requests rather than traces", async () => {
  const error = await Effect.runPromise(
    authenticationTokenFromEnvironment("invalid-name").pipe(Effect.flip),
  );
  expect(error.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(error.retryable).toBe(true);
  expect(error).not.toHaveProperty("traceId");
});
