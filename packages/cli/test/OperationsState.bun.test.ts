import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationsState, OperationsStateDocument } from "../src/OperationsState.ts";

const increment = (state: OperationsStateDocument) =>
  new OperationsStateDocument({
    version: state.version,
    generation: state.generation,
    service: state.service,
    manualActions: state.manualActions,
    mutations: state.mutations,
  });

describe("operations state", () => {
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
});
