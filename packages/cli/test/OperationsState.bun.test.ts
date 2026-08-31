import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationsState, OperationsStateDocument } from "../src/OperationsState.ts";

const decodeLockFixture = Schema.decodeUnknownSync(
  Schema.Struct({ token: Schema.NonEmptyString, heartbeatAt: Schema.Number }),
);
const decodeHeartbeat = Schema.decodeUnknownSync(Schema.NumberFromString);

const increment = (state: OperationsStateDocument) =>
  new OperationsStateDocument({
    version: state.version,
    generation: state.generation,
    service: state.service,
    manualActions: state.manualActions,
    mutations: state.mutations,
  });

describe("operations state", () => {
  test.serial("keeps active leases, renews holders, and reclaims expired crashes", async () => {
    const home = await mkdtemp(join(tmpdir(), "observability-state-lease-"));
    const previousHome = process.env.OBSERVABILITY_HOME;
    const previousNodeEnvironment = process.env.NODE_ENV;
    const previousHold = process.env.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS;
    process.env.OBSERVABILITY_HOME = home;
    process.env.NODE_ENV = "test";
    process.env.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS = "1800";
    const operations = join(home, "operations");
    const lockPath = join(operations, "checkout.lock");
    await mkdir(operations, { recursive: true });
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: 1, token: crypto.randomUUID(), heartbeatAt: Date.now() })}\n`,
      );
      const permissionSeparatedOwner = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OperationsState;
          return yield* Effect.exit(store.update("checkout", 0, increment));
        }).pipe(Effect.provide(OperationsState.layer)),
      );
      expect(Exit.isFailure(permissionSeparatedOwner)).toBe(true);
      await rm(lockPath);

      const heldUpdate = Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OperationsState;
          return yield* store.update("checkout", 0, increment);
        }).pipe(Effect.provide(OperationsState.layer)),
      );
      await Bun.sleep(150);
      const owner = decodeLockFixture(JSON.parse(await readFile(lockPath, "utf8")));
      const heartbeatPath = join(operations, `checkout.heartbeat-${owner.token}`);
      const initialHeartbeat = decodeHeartbeat(await readFile(heartbeatPath, "utf8"));
      const busy = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OperationsState;
          return yield* Effect.exit(store.update("checkout", 0, increment));
        }).pipe(Effect.provide(OperationsState.layer)),
      );
      expect(Exit.isFailure(busy)).toBe(true);
      await Bun.sleep(1_050);
      const renewedHeartbeat = decodeHeartbeat(await readFile(heartbeatPath, "utf8"));
      expect(renewedHeartbeat).toBeGreaterThan(initialHeartbeat);
      await heldUpdate;

      process.env.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS = "0";
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: 1, token: crypto.randomUUID(), heartbeatAt: Date.now() - 10_000 })}\n`,
      );
      const reclaimed = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OperationsState;
          return yield* store.update("checkout", 1, increment);
        }).pipe(Effect.provide(OperationsState.layer)),
      );
      expect(reclaimed.generation).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.OBSERVABILITY_HOME;
      else process.env.OBSERVABILITY_HOME = previousHome;
      if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnvironment;
      if (previousHold === undefined)
        delete process.env.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS;
      else process.env.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS = previousHold;
      await rm(home, { recursive: true, force: true });
    }
  });

  test.serial("compares the expected generation under the process lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "observability-state-cas-"));
    const previous = process.env.OBSERVABILITY_HOME;
    process.env.OBSERVABILITY_HOME = home;
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OperationsState;
          const initial = yield* store.load("checkout");
          const first = yield* Effect.exit(store.update("checkout", initial.generation, increment));
          const stale = yield* Effect.exit(store.update("checkout", initial.generation, increment));
          return [first, stale];
        }).pipe(Effect.provide(OperationsState.layer)),
      );
      expect(result.filter(Exit.isSuccess)).toHaveLength(1);
      const failure = result.find(Exit.isFailure);
      if (failure === undefined || !Exit.isFailure(failure))
        throw new Error("Expected CAS failure.");
      expect(String(failure.cause)).toContain("changed from generation 0 to 1");
    } finally {
      if (previous === undefined) delete process.env.OBSERVABILITY_HOME;
      else process.env.OBSERVABILITY_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test.serial("rejects negative and unsafe hand-edited generations", async () => {
    const home = await mkdtemp(join(tmpdir(), "observability-state-generation-"));
    const previous = process.env.OBSERVABILITY_HOME;
    process.env.OBSERVABILITY_HOME = home;
    const operations = join(home, "operations");
    const statePath = join(operations, "checkout.json");
    await mkdir(operations, { recursive: true });
    try {
      for (const generation of [-1, Number.MAX_SAFE_INTEGER + 1]) {
        await writeFile(
          statePath,
          `${JSON.stringify({
            version: 1,
            generation,
            service: "checkout",
            manualActions: [],
            mutations: [],
          })}\n`,
        );
        const error = await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* OperationsState;
            return yield* Effect.flip(store.load("checkout"));
          }).pipe(Effect.provide(OperationsState.layer)),
        );
        expect(error.code).toBe("OBS_CLI_OPERATIONS_STATE_INVALID");
      }
    } finally {
      if (previous === undefined) delete process.env.OBSERVABILITY_HOME;
      else process.env.OBSERVABILITY_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test.serial("rejects generation increment overflow", async () => {
    const home = await mkdtemp(join(tmpdir(), "observability-state-overflow-"));
    const previous = process.env.OBSERVABILITY_HOME;
    process.env.OBSERVABILITY_HOME = home;
    const operations = join(home, "operations");
    await mkdir(operations, { recursive: true });
    await writeFile(
      join(operations, "checkout.json"),
      `${JSON.stringify({
        version: 1,
        generation: Number.MAX_SAFE_INTEGER,
        service: "checkout",
        manualActions: [],
        mutations: [],
      })}\n`,
    );
    try {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* OperationsState;
          return yield* Effect.flip(store.update("checkout", Number.MAX_SAFE_INTEGER, increment));
        }).pipe(Effect.provide(OperationsState.layer)),
      );
      expect(error.code).toBe("OBS_CLI_OPERATIONS_STATE_INVALID");
    } finally {
      if (previous === undefined) delete process.env.OBSERVABILITY_HOME;
      else process.env.OBSERVABILITY_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});
